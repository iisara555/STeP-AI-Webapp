import sys
from authority import Authority, FakeManager

db, effects, action, request = sys.argv[1:]
a = Authority(db, FakeManager(effects), 1)
if action == 'start': a.start('alice', request, 'work')
elif action == 'stop':
    op, _ = a.start('alice', request, 'work')
    a.stop('alice', op)
else: raise ValueError(action)
