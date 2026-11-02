"""
本地静态服务器 + 遥测收集
- GET  /xxx.user.js   供页面 fetch 注入脚本
- POST /report        脚本把运行数据写进 telemetry.log
所有响应带 CORS，允许从 http://www.gaoxiaokaoshi.com 跨域调用。
"""
import http.server
import os
import sys

PORT = 8765
BASE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(BASE, 'telemetry.log')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=BASE, **kw)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        if self.path.split('?')[0] == '/report':
            n = int(self.headers.get('Content-Length') or 0)
            body = self.rfile.read(n).decode('utf-8', 'replace')
            with open(LOG, 'a', encoding='utf-8') as f:
                f.write(body.strip() + '\n')
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'ok')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    os.chdir(BASE)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print('serving %s on http://127.0.0.1:%d  log=%s' % (BASE, PORT, LOG))
    sys.stdout.flush()
    srv.serve_forever()
