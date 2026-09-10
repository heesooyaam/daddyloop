"""Capture real daddyloop PTY output and verify terminal/daemon lifetime."""
import codecs, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time, urllib.request
node, entry, config_file, output_file, session_id = sys.argv[1:]
config=json.load(open(config_file));origin=config['serverUrl']
def health():
    with urllib.request.urlopen(origin+'/api/health') as response:return json.load(response)
pid=health()['pid'];events=[];snapshots=[]
master,slave=pty.openpty();before=termios.tcgetattr(slave)
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',38,124,0,0))
env={**os.environ,'REVIEWLOOP_CONFIG':config_file,'TERM':'xterm-256color','COLORTERM':'truecolor','FORCE_COLOR':'3'};env.pop('NO_COLOR',None)
child=subprocess.Popen([node,entry,'--language','ru','console',session_id],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
decoder=codecs.getincrementaldecoder('utf-8')();plain='';ansi=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
def drain(seconds=.15):
    global plain
    until=time.monotonic()+seconds
    while time.monotonic()<until:
        ready,_,_=select.select([master],[],[],.03)
        if ready:
            try: chunk=os.read(master,65536)
            except OSError:return
            if not chunk:return
            text=decoder.decode(chunk);events.append({'data':text});plain+=ansi.sub('',text)
def wait(text):
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        drain(.1)
        if text in plain:return
        if child.poll() is not None:break
    raise RuntimeError('Missing terminal state: '+text)
def send(text):os.write(master,text.encode());drain(.3)
def snapshot(name):drain(.6);snapshots.append({'name':name,'at':len(events)})
try:
    wait('daddyloop.');wait('Писатели:');snapshot('daddy-cli')
    send('/pool');send('\r');wait('Пул писателей');snapshot('daddy-cli-pool')
    send('\x1b');send('/limits');send('\r');wait('Лимиты Codex');wait('Доступно сбросов:');snapshot('daddy-cli-limits')
    send('\x1b');send('/new');send('\r');wait('Выбрать проект');snapshot('daddy-cli-projects')
    send('\x1b');send('\x11')
    deadline=time.monotonic()+10
    while child.poll() is None and time.monotonic()<deadline:drain(.1)
    assert child.poll()==0,'Console did not close'
    assert termios.tcgetattr(slave)[3]&(termios.ICANON|termios.ECHO)==before[3]&(termios.ICANON|termios.ECHO),'Terminal modes were not restored'
    assert health()['pid']==pid,'Console exit affected the server'
    with open(output_file,'w') as result:json.dump({'columns':124,'rows':38,'events':events,'snapshots':snapshots,'verified':True},result)
finally:
    if child.poll() is None:child.terminate();child.wait(timeout=10)
    os.close(master);os.close(slave)
