#!/bin/bash
# Rebuild showcase from the latest index.html (index.html is never modified)
set -e
cd "$(dirname "$0")"
cp ../index.html game_copy.html
python3 - << 'PY'
s=open('game_copy.html',encoding='utf-8').read()
marker='\nshowLogin();\n'
assert s.count(marker)==1, s.count(marker)
inj='\nwindow.__dbg={ITEMS,drawHumanoid,playerSpriteOpt,jobLook,CHAR_SCALE};\n'
s=s.replace(marker, inj+marker, 1)
s=s.replace('</body>','<script src="showcase.js"></script>\n</body>',1)
open('equipment_showcase.html','w',encoding='utf-8').write(s)
PY
