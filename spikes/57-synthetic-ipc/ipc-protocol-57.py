#!/usr/bin/env python3
"""Synthetic protocol experiment. No production imports, provider, or workspace data."""
import json, os, socket, struct, subprocess, tempfile, time, uuid
from pathlib import Path
NODE='/home/itsara/.hermes/tools/node-26.12.1-linux-x64/bin/node'
SERVICE=r'''
const net = require('node:net');
const socket = net.createConnection(process.argv[2]);
let buf='';
function send(m) { socket.write(JSON.stringify(m)+'\n'); }
socket.setEncoding('utf8');
socket.on('connect',()=>send({type:'ready'}));
socket.on('data', chunk => {
  buf += chunk;
  for (;;) {
    const n=buf.indexOf('\n'); if(n<0) break;
    const m=JSON.parse(buf.slice(0,n)); buf=buf.slice(n+1);
    (async()=>{
      try {
        if(m.method==='fail') throw Error('SYNTHETIC_FAILURE');
        if(m.method!=='echo') throw Error('UNKNOWN_METHOD');
        if(m.params.delay) await new Promise(r=>setTimeout(r,m.params.delay));
        send({type:'event',event:{sessionId:'synthetic',type:'status',text:m.params.value}});
        send({type:'result',nonce:m.nonce,ok:true,result:m.params.value});
      } catch(e) { send({type:'result',nonce:m.nonce,ok:false,code:e.message}); }
    })();
  }
});
socket.on('end',()=>process.exit(0));
socket.on('error',()=>process.exit(3));
'''
def ctl(*args, check=True):
    return subprocess.run(['systemctl','--user',*args],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=check,timeout=10)
def line(s): return (json.dumps(s,ensure_ascii=False,separators=(',',':'))+'\n').encode()
def recvline(conn, state):
    while b'\n' not in state[0]:
        chunk=conn.recv(65536)
        if not chunk: raise AssertionError('premature EOF')
        state[0]+=chunk
    a,state[0]=state[0].split(b'\n',1)
    return json.loads(a)
def assert_eq(a,b):
    if a!=b: raise AssertionError(f'{a!r} != {b!r}')
unit='hermes57-ipc-'+uuid.uuid4().hex+'.service'
with tempfile.TemporaryDirectory(prefix='ipc57-',dir=os.environ.get('TMPDIR','/home/itsara/.hermes/cache/scratch')) as d:
    os.chmod(d,0o700)
    path=str(Path(d)/'s'); Path(d,'service.cjs').write_text(SERVICE)
    server=socket.socket(socket.AF_UNIX); server.settimeout(10); server.bind(path); os.chmod(path,0o600); server.listen(8)
    launched=False
    try:
        # Same-UID impostor can connect and send a valid ready; UID check alone passes.
        fake=subprocess.Popen([NODE,'-e',"const n=require('node:net');const s=n.createConnection(process.argv[1]);s.on('connect',()=>s.end(JSON.stringify({type:'ready'})+'\\n'));",path])
        try:
            c,_=server.accept(); c.settimeout(5)
            pid,uid,gid=struct.unpack('3i',c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
            assert_eq(uid,os.getuid()); assert_eq(pid,fake.pid); assert_eq(recvline(c,[b'']),{'type':'ready'})
            c.close(); assert_eq(fake.wait(timeout=5),0)
        finally:
            if fake.poll() is None: fake.kill(); fake.wait(timeout=5)
        print('PASS distinct forged same-UID process passes UID-only check and sends ready')
        cmd=['systemd-run','--user','--quiet','--unit',unit,'--property=Type=exec','--property=RuntimeMaxSec=30s','--property=KillMode=control-group',NODE,str(Path(d,'service.cjs')),path]
        launched=True
        subprocess.run(cmd,check=True,timeout=10,capture_output=True,text=True)
        c,_=server.accept(); c.settimeout(5); state=[b'']
        pid,uid,gid=struct.unpack('3i',c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        mainpid=int(ctl('show',unit,'--property=MainPID','--value').stdout.strip())
        assert_eq(uid,os.getuid()); assert_eq(pid,mainpid); assert_eq(recvline(c,state),{'type':'ready'})
        print('PASS systemd service peer SO_PEERCRED UID/PID match and ready')
        # First request split inside UTF-8; later frames coalesced; slow response completes last.
        requests=[{'type':'call','nonce':1,'method':'echo','params':{'value':'สวัสดี\nsynthetic','delay':200}}, {'type':'call','nonce':2,'method':'echo','params':{'value':'fast','delay':0}}, {'type':'call','nonce':3,'method':'fail','params':{}}]
        data=b''.join(map(line,requests)); i=data.index('ส'.encode())+1
        c.sendall(data[:i]); time.sleep(.03); c.sendall(data[i:])
        messages=[recvline(c,state) for _ in range(5)]
        results=[m for m in messages if m['type']=='result']; events=[m for m in messages if m['type']=='event']
        assert_eq([m['nonce'] for m in results],[2,3,1]); assert_eq(results[0],{'type':'result','nonce':2,'ok':True,'result':'fast'}); assert_eq(results[1],{'type':'result','nonce':3,'ok':False,'code':'SYNTHETIC_FAILURE'}); assert_eq(results[2],{'type':'result','nonce':1,'ok':True,'result':'สวัสดี\nsynthetic'}); assert_eq([e['event']['text'] for e in events],['fast','สวัสดี\nsynthetic'])
        print('PASS split UTF-8 frame, coalesced requests, events, error, nonce correlation, out-of-order concurrent results')
        # Outstanding operation is cut off by manager disconnect, rather than implicitly completing.
        c.sendall(line({'type':'call','nonce':4,'method':'echo','params':{'value':'never','delay':3000}})); c.shutdown(socket.SHUT_WR)
        assert_eq(c.recv(1024),b''); c.close()
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            stateunit=ctl('show',unit,'--property=ActiveState','--value').stdout.strip()
            if stateunit in ('inactive','failed'): break
            time.sleep(.05)
        assert_eq(stateunit,'inactive'); print('PASS disconnect exits service; in-flight call receives no result')
    finally:
        server.close()
        if launched:
            ctl('stop',unit,check=False); ctl('reset-failed',unit,check=False)
            out=ctl('show',unit,'--property=LoadState','--property=ActiveState','--property=MainPID',check=False).stdout.strip()
            print('CLEANUP',unit,out.replace('\n',' '))
            if 'MainPID=0' not in out or 'ActiveState=inactive' not in out or 'LoadState=not-found' not in out:
                raise AssertionError('unit not cleaned up: '+out)
print('CLEANUP temporary directory removed')
