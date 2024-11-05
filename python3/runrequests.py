import argparse
import json
import asyncio
import aiohttp
import copy
import hashlib
from urllib.parse import urljoin
from pathlib import Path

# Parse command-line options
parser = argparse.ArgumentParser(usage="[options] runrequests.py")
parser.add_argument("--request", required=True, help="template request file (json)")
parser.add_argument("--queries", required=True, help="queries file (plain text)")
parser.add_argument("-b", "--base", help="Base URL to resolve relative request URIs against.")
parser.add_argument("-p", "--parallelism", type=int, default=1, help="Parallelism level.")
parser.add_argument("--write-responses", help="Write responses to the provided directory.")
parser.add_argument("--expand-query", help="Expand template requests with queries from file.")
args = parser.parse_args()


# Read the request template
with open(args.request, "r", encoding="utf-8") as file:
    req_template = json.load(file)[0]

# Read input queries.
with open(args.queries, "r", encoding="utf-8") as file:
    queries = [line.strip() for line in file if line.strip()]

# Prepare output directory, if provided.
if args.write_responses:
    target_dir = Path(args.write_responses)
    target_dir.mkdir(parents=True, exist_ok=True)


url = urljoin(args.base, req_template["url"])


async def process_response(req, md5, res):
    num_found = res.get("response", {}).get("numFound", 0)
    status = "OK," if num_found > 0 else "--,"
    print(status + md5 + ": " + str(req['body']['query']))
    if args.write_responses and num_found > 0:
        target_path = target_dir / (md5 + ".json")
        filtered = {
            "request": req,
            "response-filtered": {
                "numFound": num_found,
                "highlights": res.get("highlighting", {})
            }
        }
        with open(target_path, "w", encoding="utf-8") as file:
            json.dump(filtered, file, indent=2)

async def process_query(session, query):
    req = copy.deepcopy(req_template)
    req["body"]["query"] = query

    req_str = json.dumps(req, indent="  ", sort_keys=True)
    md5 = hashlib.md5(req_str.encode()).hexdigest()

    try:
        async with session.post(url, json=req['body']) as response:
            response_data = await response.json()
            await process_response(req, md5, response_data)
    except Exception as ex:
        print("ERROR; failed to process request: " + md5 + ": " + query + " => " + str(ex))


# Expand the template for each request, run using asyncio.
async def mainloop():
    running = []
    async with aiohttp.ClientSession() as session:
        for query in queries:
            while len(running) >= args.parallelism:
                finished, unfinished = await asyncio.wait(running, return_when=asyncio.FIRST_COMPLETED)
                for f in finished:
                    running.remove(f)
                pass

            running.append(asyncio.create_task(process_query(session, query)))
            pass
        await asyncio.wait(running, return_when=asyncio.ALL_COMPLETED)


# Process all queries.
asyncio.run(mainloop())
