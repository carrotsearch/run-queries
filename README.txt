This package runs batch requests to Solr using a JSON query template
and a plain text query-per-line file.

* Installation (python3 subfolder)

- python3 -m pip install -r requirements.txt --user

- Alternatively, you can use a python's venv (virtual environment) to install the dependencies.
  - python3 -m venv .venv
  - source .venv/bin/activate
  - python3 -m pip install -r requirements.txt


* Request template file

Prepare a "solr query template" and a list of text queries that should be sent
to Solr using this template (one per line). Here is an example query template:

[
  {
    "method": "POST",
    "url": "/solr/wos/select",
    "expand": [
      "$.body.query"
    ],
    "body": {
      "query": "$query",
      "offset": 0,
      "limit": 10,
      "fields": ["none"],
      "params": {
        "df": "author_all,grant_agency,grant_source,fund_text",
        "hl": true,
        "hl.snippets": "5",
        "hl.fragsize": "600",
        "hl.simple.pre": "⁌",
        "hl.simple.post": "⁍",

        "f.id.hl.always": true,
        "f.title.hl.always": true,

        "hl.fl": [
          "id",
          "title",

          "author_all",
          "grant_agency",
          "grant_source",
          "fund_text"
        ]
      }
    }
  }
]

The "url" element is either a full URL or a URL path to the Solr service. The "body" element contains
Solr json query to be sent to the server. Important elements:

- "expand" -> this is an array of json paths applied against the request template. Any "$query" text
  at those paths is replaced with the current query from the queries file.
- "body" -> limit: how many documents (max) to return,
- "body -> params -> df": a set of default fields which should be included for each line in the query file,
- "body -> params -> hl.fl": a set of fields for which "highlights" should be returned. Highlights include
  regions of the source text which generated a "hit" (caused the document to be included). 
- hl.simple.pre and hl.simple.post are highlight markers used to mark a query hit in the response.

Typically, the fields in df will be copied to highlights because you'd like to see the context where each
query occurred.


* Running queries against a template 

The query file is a plain text, UTF-8 encoded, file, with one query per line. Here is an example:

"Interacting Infrastructure Disruptions"
hummel*
"sea pollution"
adidas
nike
"bill gates"
fn:maxwidth(10 fn:atleast(2 fn:ordered(nike adidas puma)))

To run all these queries against a template, execute (replacing SOLR-ADDRESS with an appropriate base URL to Solr):

mkdir responses
python3 runrequests.py --base https://SOLR-ADDRESS --queries ../example-queries/queries.txt --request ../example-requests/proposals.json --write-responses responses
python3 runrequests.py --base https://SOLR-ADDRESS --queries ../example-queries/queries.txt --request ../example-requests/wos.json --write-responses responses


* Responses

The responses folder will be populated with json files corresponding to those 
server responses, which returned non-zero results. Each such file has a alphanumeric name
derived from an md5 checksum of its full json request sent to the server and
contains the following blocks (comments are added for clarity):

{
  // a copy of the request, including the query for this particular request in the 'body' block.
  "request": {
    "method": "POST",
    // ...[omitted]...
    "body": {
      "query": "\"bill gates\"",
      // ...[omitted]...
    },
    "hash": "5f35d2c2bd4bb81a745eb9be4cba3d84"
  },
  // filtered Solr response.
  "response-filtered": {
    // the number of matching documents (exact or approximate)
    "numFound": 5,
    // highlight fields. 
    "highlights": {
      // ID of the document, fields inside.
      "1254535": {
        "bio": [
          // ...[omitted]...
        ],
        "id": [
          "0000000"
        ],
        "title": [
          // ...[omitted]...
        ]
      },

      // ...[omitted]...
    }
  }
}


* Parallelism

The program supports sending requests to the server using concurrent connections. The --parallelism option takes an argument which
can specify how many concurrent connections should be established. Even "--parallelism 2" should be typically sufficient.

Try not to abuse the service.
