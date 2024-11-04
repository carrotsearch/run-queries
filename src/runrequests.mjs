import path from "node:path"
import fs from "fs";
import {Command} from 'commander';
import "colors";
import process from 'node:process';
import walk from "walkdir";
import {resolve} from 'node:url';
import superagent from 'superagent';
import {md5} from 'js-md5';
import { JSONParser } from '@streamparser/json';
import { PromisePool } from '@supercharge/promise-pool'

const originalWarn = console.warn;
console.warn = (...args) => {
    console.log(new Error().stack)
    originalWarn(...args)
}

// Parse cmd line options.
const program = new Command();
program
    .usage("[options] json-request-files-or-directories")
    .option("-b, --base <url>", "Base URL to resolve relative request URIs against.")
    .option("-p, --parallelism <parallelism>", "Parallelism level.", "1")
    .option("--response-size", "Include response size in bytes.", true)
    .option("--dump-request <hash>", "Dump the request with the given hash to console.")
    .option("--dump-response <hash>", "Dump the request with the given hash to console, along with its response.")
    .option("--write-responses <directory>", "Write Solr responses to the provided directory.")
    .option("--expand-query <queries>", "Expand template requests with queries from file.")
    .option("--dry-run", "Dry run mode.", false)
    .option("--no-accept-gzip", "Don't accept gzip content encoding")
    .parse(process.argv);

// Extract cmd line options.
const options = program.opts();
const baseUrl = options.base;
const parallelism = Number(options.parallelism);
const includeResponseSize = options.responseSize

// Create helper functions.
const resolveUrl = (baseUrl === undefined ? url => url : url => {
    return resolve(baseUrl, url);
});

// collect all input files.
const inputFiles = program.args.map(val => walk.sync(val))
    .flat()
    .filter(path => path.endsWith(".json") || path.endsWith(".txt"))
    .sort();

// process requests.
let requestCount = 0;
let totalTime = 0;
let resOther = 0;
let dryRun = options.dryRun || options.dumpRequest !== undefined;
let start = process.hrtime.bigint();

let expandQueries = []
if (options.expandQuery) {
    expandQueries = fs.readFileSync(options.expandQuery, {encoding: "UTF8"})
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length !== 0);
}

process.stdout.write(`#status,t.total,t.firstByte,time.q,query-hash,response-size,num-docs\n`);

for (const file of inputFiles) {
    let requests;
    if (file.endsWith(".txt")) {
        requests = fs.readFileSync(file, {encoding: "UTF8"})
            .split("\n")
            .map(line => line.trim())
            .filter(line => line.length !== 0)
            .map(line => {
                return {"method": "GET", "url": line}
            });
    } else {
        requests = JSON.parse(fs.readFileSync(file));
    }

    requests = requests
        .map(request => {
            request.url = resolveUrl(request.url);
            return request;
        })
        .flatMap(req => {
            if (req.expand && req.expand.query) {
                return expandQueries.map(query => {
                    return {
                        ...req,
                        "body": {
                            ...req.body,
                            "query": query
                        }
                    };
                });
            } else {
                return req;
            }
        })
        .map(req => {
            req.hash = md5(JSON.stringify(req, null, "  "));
            return req;
        });

    const requestFiltering = options.dumpResponse !== undefined;
    if (requestFiltering) {
        requests = requests.filter(req => {
            return req.hash === options.dumpResponse;
        });
    }

    let responseDumper = (req, res) => {
        // no-op.
    }

    if (options.writeResponses) {
        const targetDir = options.writeResponses;
        if (!fs.existsSync(targetDir)) {
            process.stderr.write("The argument to --write-responses must be a directory: " + targetDir);
            process.exit(1);
        }

        responseDumper = (req, res) => {
            const target = path.join(targetDir, req.hash + ".json");
            const bodyJson = JSON.parse(res.body);
            const filtered = {
                "request": req,
                "response-filtered": {
                    "numFound": bodyJson.response.numFound,
                    "highlights": bodyJson.highlighting
                }
            }
            fs.writeFileSync(target, JSON.stringify(filtered, null, "  "));
        }
    }

    await PromisePool
        .withConcurrency(parallelism)
        .for(requests)
        .process(async req => {
            if (dryRun) {
                if (options.dumpRequest !== null) {
                    if (req.hash === options.dumpRequest) {
                        process.stderr.write(`Request ${req.hash}:\n${JSON.stringify(req, null, "  ")}\n`.gray);
                    }
                }
            } else {
                let res;
                if (req.method === "GET") {
                    res = await processGet(req);
                } else if (req.method === "POST") {
                    res = await processPost(req);
                } else {
                    process.stderr.write(("ERROR: unknown request type: " + JSON.stringify(req, null, "  ") + "\n").red);
                }

                if (requestFiltering) {
                    if (res.request.hash === options.dumpResponse) {
                        process.stderr.write(`Request ${res.request.hash}:\n${JSON.stringify(res.request, null, "  ")}\n`.gray);
                        process.stderr.write(`Response:\n${JSON.stringify(res.body, null, "  ")}\n`.gray);
                    }
                }

                let qTime = undefined;
                let numDocs = undefined;
                if (res.body) {
                    const parser = new JSONParser({
                        paths: [
                            "$.responseHeader",
                            "$.response.numFound",
                        ]
                    });
                    parser.onValue = (partial) => {
                        if (partial.key === "responseHeader") {
                            qTime = partial.value.QTime;
                        } else if (partial.key === "numFound") {
                            numDocs = partial.value;
                        }
                    };

                    try {
                        parser.write(res.body);
                    } catch (e) {
                        process.stderr.write("Can't parse response body: " + res.request.hash + "\n");
                    }
                }
                const hash = res.request.hash;
                const status = res.status;
                const responseTimes = res.responseTimes || {}

                // We're only interested in dumping responses for which there were any documents.
                if (numDocs > 0) {
                    try {
                        responseDumper(req, res);
                    } catch (e) {
                        process.stderr.write("Err: " + e);
                    }
                }

                requestCount++;
                if (responseTimes.timeTotal !== undefined) {
                    totalTime += responseTimes.timeTotal;
                }

                if ((requestCount % parallelism) === 0) {
                    process.stderr.write(`-- chunk complete ${requestCount}/${requests.length}, ${file}\n`.gray);
                }

                if (status !== 200) {
                    resOther++;
                }

                const responseSize = responseTimes?.bodyLength;
                process.stdout.write(`${status},${responseTimes.timeTotal},${responseTimes.timeToFirstByte},${qTime},${hash},${responseSize},${numDocs}\n`);
            }
        });
}


const doneTime = process.hrtime.bigint() - start;
const msg = `Done in ${doneTime / BigInt('1000000')} msec, requests: ${requestCount}, avg: ${Math.round(totalTime / requestCount)} msec., errors: ${resOther}\n`
process.stdout.write("# " + msg)
process.stderr.write(msg)

// Request processing functions.
function handleError(req, err) {
    return {
        "status": err.status,
        "request": req,
        "body": JSON.stringify(err.response, null, "  ")
    };
}

function processGet(req) {
    return common(req, superagent.get(req.url))
}

function processPost(req) {
    return common(req, superagent.post(req.url).send(req.body));
}

function common(req, superagent) {
    let responseTimes;
    return superagent.maxResponseSize(4000000000)
        .timeout({
            response: 60000,
            deadline: 60000,
        })
        .use(recordRequestTimes((res, times) => {
            responseTimes = times;
        }))
        .set(options.acceptGzip ? {} : {"Accept-Encoding": ""})
        .buffer(false).parse((res, fn) => {
            let header = "";
            res.on('data', (data) => {
                if (header.length < 1024 * 1024 * 20) {
                    header += data;
                }
            });
            res.on('end', () => {
                fn(undefined, header);
            })
        })
        .then(res => {
            return {
                "status": res.status,
                "request": req,
                "body": res.body,
                responseTimes
            }
        })
        .catch(err => handleError(req, err));
}

function recordRequestTimes(callback) {
    return agent => {
        agent.on('request', ({req}) => {
            let sw;

            req.on('socket', (socket) => {
                socket.on('connect', () => {
                    sw = stopwatch();
                });
            });

            req.on('response', (res) => {
                const times = {
                    'bodyLength': 0
                };

                res.once('readable', () => {
                    times['timeToFirstByte'] = sw.elapsed();
                });
                res.on('data', (data) => {
                    times.bodyLength += data.length;
                });
                res.on('end', () => {
                    times['timeTotal'] = sw.elapsed();
                    callback(res, times);
                });
            });
        });
    };
}

function stopwatch() {
    const start = process.hrtime.bigint();
    return {
        "elapsed": () => {
            return Number(((process.hrtime.bigint() - start) / BigInt("1000000")).toString());
        }
    }
}
