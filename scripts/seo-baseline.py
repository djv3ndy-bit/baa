#!/usr/bin/env python3
"""Read-only public HTTP/source inventory. No credentials or database access.

Run from the repository root: python3 scripts/seo-baseline.py --output /tmp/seo.json
Requires Python 3 and curl; only GETs the public website. Does not execute JS.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from hashlib import sha256
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
import tempfile


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.metadata = {}
        self.canonicals = []
        self.links = []
        self.images = []
        self.scripts = []
        self.headings = []
        self.title = ''
        self.capture = None
        self.json_ld_count = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'meta':
            key = a.get('name', a.get('property'))
            if key:
                self.metadata[key] = a.get('content', '')
        if tag == 'link' and a.get('rel') == 'canonical':
            self.canonicals.append(a.get('href'))
        if tag == 'a' and a.get('href'):
            self.links.append(a['href'])
        if tag == 'img':
            self.images.append({k: a.get(k) for k in ('src', 'alt', 'width', 'height', 'loading', 'fetchpriority')})
        if tag == 'script':
            if a.get('src'):
                self.scripts.append(a['src'])
            if a.get('type') == 'application/ld+json':
                self.json_ld_count += 1
        if tag == 'title':
            self.capture = 'title'
        elif re.fullmatch('h[1-6]', tag):
            self.headings.append({'level': tag, 'text': ''})
            self.capture = tag

    def handle_endtag(self, tag):
        if tag == self.capture:
            self.capture = None

    def handle_data(self, data):
        if self.capture == 'title':
            self.title += data
        elif self.capture:
            self.headings[-1]['text'] += data

    def result(self):
        return {k: v for k, v in vars(self).items() if k in (
            'metadata', 'canonicals', 'links', 'images', 'scripts', 'headings', 'title', 'json_ld_count')}


def inspect(data):
    page = Page()
    page.feed(data.decode('utf-8', errors='replace'))
    return {'sha256': sha256(data).hexdigest(), 'bytes': len(data), **page.result()}


def fetch(url):
    with tempfile.TemporaryDirectory() as directory:
        body, headers = Path(directory) / 'body', Path(directory) / 'headers'
        result = subprocess.run([
            'curl', '--silent', '--show-error', '--location', '--max-time', '25',
            '--max-redirs', '5', '--dump-header', str(headers), '--output', str(body),
            '--write-out', '%{json}', url,
        ], capture_output=True, text=True)
        if result.returncode:
            return {'requested_url': url, 'error': result.stderr.strip()}
        info = json.loads(result.stdout)
        blocks = re.split(r'\r?\n\r?\n', headers.read_text())
        hops = []
        final_headers = {}
        for block in blocks:
            lines = block.splitlines()
            if not lines or not lines[0].startswith('HTTP/'):
                continue
            values = dict((k.lower(), v.strip()) for k, v in
                          (line.split(':', 1) for line in lines[1:] if ':' in line))
            final_headers = {k: v for k, v in values.items() if k in (
                'content-type', 'cache-control', 'x-robots-tag', 'location', 'etag', 'last-modified')}
            if 'location' in values:
                hops.append({'status': int(lines[0].split()[1]), 'location': values['location']})
        data = body.read_bytes()
        return {
            'requested_url': url, 'final_url': info['url_effective'],
            'status': info['http_code'], 'redirects': hops, 'headers': final_headers,
            'total_seconds': info['time_total'], 'ttfb_seconds': info['time_starttransfer'],
            'note': 'Single audit-client observation; not a Core Web Vitals measurement.',
            **inspect(data),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    origin = 'https://www.baristajobmatch.com'
    files = sorted(Path('.').glob('*.html'))
    routes = ['/' if p.stem == 'index' else '/' + p.stem for p in files]
    routes += ['/robots.txt', '/sitemap.xml', '/index.html', '/support.html', '/support/',
               '/privacy.html', '/terms.html', '/delete-account.html', '/owner-reliability',
               '/barista-jobs', '/barista-jobs/miami-fl', '/barista-jobs/fort-lauderdale-fl',
               '/hire-baristas', '/seo-audit-missing-page-62']
    urls = [origin + route for route in routes]
    urls += ['https://baristajobmatch.com/', 'http://www.baristajobmatch.com/']
    with ThreadPoolExecutor(max_workers=4) as pool:
        pages = list(pool.map(fetch, urls))
    report = {
        'observed_at_utc': datetime.now(timezone.utc).isoformat(),
        'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'method': 'Unauthenticated public GETs with redirect following; source HTML parsing, no JavaScript execution.',
        'limitations': ['No Search Console, Google URL Inspection, CrUX or authenticated database state measured.',
                         'HTTP 200 and crawlable HTML do not prove Google indexing.',
                         'Source policy is not proof of deployed database policy.'],
        'source_pages': {str(p): inspect(p.read_bytes()) for p in files},
        'live_pages': pages,
    }
    Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
    for page in pages:
        print(page.get('status', 'ERROR'), page['requested_url'], '->', page.get('final_url', page.get('error')))


if __name__ == '__main__':
    main()
