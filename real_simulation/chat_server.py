#!/usr/bin/env python3
"""GuideMate — minimal chat front-end server (stdlib only, no framework).

Serves a tiny chat box and wires it to the dispatcher:
    browser --(POST /api/chat)--> parse_mission() --> {origin, destination}
           --(POST /api/run)---> subprocess dispatcher.py --> robots move

Run (its own terminal, after a robot's sim + nav are up):
    python3 real_simulation/chat_server.py         # then open http://127.0.0.1:8080

The relay is sequential (one robot's leg at a time on this box), so the page has a
Leg selector: run "leg 1" while robot_1 is up, "leg 2" while robot_2 is up, or
"full relay" if both stacks are running (heavier).
"""
import json, subprocess, html, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from chat_intent import parse_mission, LOCATIONS
HERE = os.path.dirname(os.path.abspath(__file__))

HOST, PORT = "127.0.0.1", 8080
ROS_PREFIX = (
    "source /opt/ros/jazzy/setup.bash; "
    "unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE "
    "ROS_AUTOMATIC_DISCOVERY_RANGE FASTDDS_BUILTIN_TRANSPORTS; export ROS_DOMAIN_ID=0; "
)

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<title>GuideMate concierge</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;color:#1a1a1a}
 h1{font-size:18px} .sub{color:#666;font-size:13px;margin-top:-8px}
 #log{border:1px solid #ddd;border-radius:10px;padding:12px;height:340px;overflow:auto;background:#fafafa}
 .msg{margin:8px 0;padding:8px 12px;border-radius:12px;max-width:80%;white-space:pre-wrap;line-height:1.35}
 .you{background:#0a84ff;color:#fff;margin-left:auto} .bot{background:#e9e9eb;color:#111}
 .sys{color:#888;font-size:12px;text-align:center;margin:6px 0}
 #row{display:flex;gap:8px;margin-top:10px} #txt{flex:1;padding:10px;border:1px solid #ccc;border-radius:8px}
 button{padding:10px 14px;border:0;border-radius:8px;background:#0a84ff;color:#fff;cursor:pointer}
 button:disabled{background:#9ec9ff} select{padding:8px;border:1px solid #ccc;border-radius:8px}
</style></head><body>
<h1>🐾 GuideMate concierge</h1>
<p class="sub">Type a request like "lead me from the kitchen to the bathroom".</p>
<div id="log"></div>
<div id="row">
 <select id="leg" title="which relay leg to run">
  <option value="leg1">Leg 1 (robot_1 → door)</option>
  <option value="leg2">Leg 2 (robot_2 → dest)</option>
  <option value="full">Full relay</option>
 </select>
 <input id="txt" placeholder="lead me from the kitchen to the bathroom" autofocus>
 <button id="send">Send</button>
</div>
<script>
const log=document.getElementById('log'),txt=document.getElementById('txt'),
      send=document.getElementById('send'),leg=document.getElementById('leg');
function add(cls,text){const d=document.createElement('div');
  if(cls==='sys'){d.className='sys';d.textContent=text;}else{d.className='msg '+cls;d.textContent=text;}
  log.appendChild(d);log.scrollTop=log.scrollHeight;}
async function go(){
  const m=txt.value.trim(); if(!m)return;
  add('you',m); txt.value=''; send.disabled=true;
  try{
    const r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({message:m})}); const d=await r.json();
    add('bot',d.reply);
    if(d.understood){
      add('sys','dispatching '+leg.value+': '+d.origin+' → '+d.destination+' …');
      const rr=await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({origin:d.origin,destination:d.destination,only:leg.value})});
      const rd=await rr.json();
      add('bot',rd.ok?('✅ '+rd.summary):('⚠️ '+rd.summary)); add('sys',rd.tail||'');
    }
  }catch(e){add('sys','error: '+e);} send.disabled=false; txt.focus();
}
send.onclick=go; txt.addEventListener('keydown',e=>{if(e.key==='Enter')go();});
add('sys','Connected. One robot leg runs at a time (perf).');
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def _read(self):
        n = int(self.headers.get("content-length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        if self.path == "/":
            body = PAGE.encode()
            self.send_response(200); self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(body))); self.end_headers()
            self.wfile.write(body)
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        try:
            data = self._read()
        except Exception:
            return self._json(400, {"error": "bad json"})

        if self.path == "/api/chat":
            return self._json(200, parse_mission(str(data.get("message", ""))))

        if self.path == "/api/run":
            origin, dest = data.get("origin"), data.get("destination")
            only = data.get("only", "full")
            if origin not in LOCATIONS or dest not in LOCATIONS or only not in ("leg1", "leg2", "full"):
                return self._json(400, {"ok": False, "summary": "invalid mission params", "tail": ""})
            cmd = (ROS_PREFIX +
                   f"python3 {HERE}/dispatcher.py --origin {origin} --dest {dest} --only {only}")
            try:
                p = subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=600)
                out = (p.stdout or "") + (p.stderr or "")
                ok = "mission SUCCEEDED" in out
                # last non-empty dispatcher line as the summary
                lines = [l for l in out.splitlines() if l.strip()]
                summary = "mission complete" if ok else "mission did not complete"
                tail = "\n".join(lines[-6:])
                return self._json(200, {"ok": ok, "summary": summary, "tail": tail})
            except subprocess.TimeoutExpired:
                return self._json(200, {"ok": False, "summary": "timed out", "tail": ""})

        return self._json(404, {"error": "not found"})

    def log_message(self, *a):  # quiet
        pass


if __name__ == "__main__":
    print(f"GuideMate chat server on http://{HOST}:{PORT}  (Ctrl-C to stop)")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
