from pathlib import Path
from html import escape
import math
import subprocess
import sys

# Rebuild with Python 3, librsvg's rsvg-convert and FFmpeg (libx264).
# System Georgia and Helvetica Neue fonts are used; inspect frames after changes.
ROOT = Path(__file__).resolve().parents[2] / 'src/assets/film'
W, H, FPS, DURATION = 1280, 720, 24, 32
PAPER, INK, LEAF, MUTED = '#f5f1e7', '#173d2c', '#cbe3ac', '#c4d0c3'

def clamp(v): return max(0, min(1, v))
def ease(v):
    v = clamp(v)
    return v*v*(3-2*v)
def text(x,y,value,size=30,fill=PAPER,family='Helvetica Neue',weight='400',anchor='start'):
    return f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" fill="{fill}" font-weight="{weight}" text-anchor="{anchor}">{escape(value)}</text>'
def group(content,opacity=1,transform=''):
    return f'<g opacity="{clamp(opacity):.4f}" transform="{transform}">{content}</g>'
def line(x1,y1,x2,y2,colour=LEAF,width=2,dash=''):
    return f'<path d="M{x1} {y1} L{x2} {y2}" fill="none" stroke="{colour}" stroke-width="{width}" stroke-dasharray="{dash}"/>'
def circle(x,y,r,fill,stroke='none',width=1):
    return f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{width}"/>'
def card(x,y,w,h,fill='#214c37',stroke='#557255',radius=20):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="2"/>'
def leaf(x,y,scale=1):
    return group('<path d="M0 40 C-2 20 -18 9 -29 9 C-28 29 -15 39 0 40 M0 23 C4 5 22 -3 36 0 C32 20 18 28 0 23 M0 23 L0 58" fill="none" stroke="#cbe3ac" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',transform=f'translate({x} {y}) scale({scale})')
def file_icon(x,y,scale=1,locked=False,checked=False):
    result='<path d="M-42 -58 H16 L42 -31 V58 H-42 Z M16 -58 V-31 H42" fill="#f5f1e7" stroke="#cbe3ac" stroke-width="2" stroke-linejoin="round"/>'
    if locked:
        result+='<rect x="-20" y="-4" width="40" height="32" rx="6" fill="#173d2c"/><path d="M-12 -4 V-15 A12 12 0 0 1 12 -15 V-4" fill="none" stroke="#173d2c" stroke-width="6"/>'
        result+=circle(0,9,3,PAPER)
    elif checked:
        result+='<path d="M-19 5 L-5 19 L23 -12" fill="none" stroke="#355c3d" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'
    else:
        result+='<path d="M-24 -9 H24 M-24 7 H24 M-24 23 H9" stroke="#557255" stroke-width="5" stroke-linecap="round"/>'
    return group(result,transform=f'translate({x} {y}) scale({scale})')
def key_icon(x,y,scale=1):
    return group('<circle cx="-14" cy="-8" r="20" fill="none" stroke="#cbe3ac" stroke-width="7"/><path d="M1 6 L40 45 M24 29 L36 18 M35 40 L46 29" stroke="#cbe3ac" stroke-width="7" fill="none" stroke-linecap="round"/>',transform=f'translate({x} {y}) scale({scale})')
def heading(lines,subtitle,chapter):
    result=text(72,207,chapter,18,LEAF,weight='600')
    for i,value in enumerate(lines): result+=text(68,298+i*80,value,70,PAPER,'Georgia')
    for i,value in enumerate(subtitle): result+=text(72,472+i*42,value,28,MUTED)
    return result

def nodes(t,recover=False):
    result=''
    cx,cy=966,356
    positions=[(846,234),(1086,234),(846,478),(1086,478)]
    progress=ease((t-.8)/1.5)
    lost=ease((t-.5)/.9) if recover else 0
    for i,(x,y) in enumerate(positions):
        alive=i in (0,2) or not recover
        result+=line(cx,cy,x,y,LEAF if alive else '#718674',2,'' if alive else '5 9')
        if alive:
            phase=((t*.28+i*.22)%1)
            if recover: phase=1-phase
            result+=circle(cx+(x-cx)*phase,cy+(y-cy)*phase,5,LEAF)
        opacity=1 if alive else 1-.65*lost
        item=card(x-72,y-62,144,124,INK if not alive else '#214c37', '#718674' if not alive else '#aac58f')
        item+=text(x,y-22,f'NODE {i+1}',18,MUTED,weight='600',anchor='middle')
        if alive:
            for b in range(3): item+=card(x-35+b*24,y-1,14,22+(i+b)%3*7,LEAF,'none',3)
        else:
            item+=line(x-15,y-1,x+15,y+29,MUTED,3)+line(x+15,y-1,x-15,y+29,MUTED,3)
        item+=text(x,y+53,'OFFLINE' if not alive else 'PART '+str(i+1),16,MUTED,anchor='middle')
        result+=group(item,opacity)
        if not recover and progress<1:
            px=cx+(x-cx)*progress; py=cy+(y-cy)*progress
            result+=group(card(px-15,py-15,30,30,LEAF,'none',5),math.sin(progress*math.pi))
    result+=circle(cx,cy,61,INK,'#557255',2)
    result+=file_icon(cx,cy,.58,locked=not recover,checked=recover and t>2.0)
    return result

SCENES=[(0,5),(5,10),(10,17),(17,24),(24,32)]
def scene(i,t):
    if i==0:
        result=heading(['Your files.','More than one','way home.'],[], 'ENCRYPTED STORAGE YOU CONTROL')
        result+=text(72,568,'A little room for the unexpected.',28,MUTED)
        for r in [135,185,235]: result+=f'<ellipse cx="977" cy="349" rx="{r}" ry="{r*.76}" fill="none" stroke="#46634b" stroke-width="1" transform="rotate(-22 977 349)"/>'
        result+=circle(977,349,97,'#264c36','#759168',1)+file_icon(977,349,1,locked=True)
        for j,(x,y) in enumerate([(804,198),(1160,252),(804,460),(1148,500)]):
            result+=circle(x,y,14+math.sin(t*.9+j)*2,LEAF)
        result+=leaf(1123,451,1.3)
        return result
    if i==1:
        result=heading(['Private before','it leaves.'],['Your browser encrypts the file.','Storage nodes receive encrypted bytes.'],'01 / ENCRYPT LOCALLY')
        progress=ease((t-.6)/1.5)
        result+=circle(966,356,174,'none','#49674f',1)
        result+=circle(966,356,132,'#214c37','#779665',2)
        result+=file_icon(966,356,1.5,locked=progress>.5)
        result+=group(key_icon(1117,485,.68),progress)
        result+=text(966,590,'Your key stays with you.',27,LEAF,anchor='middle')
        return result
    if i==2:
        result=heading(['Spread the parts.','Keep your options.'],['Choose nodes you trust.','Any 2 of these 4 parts can recover.'],'02 / CHOOSE A RECOVERY LAYOUT')
        result+=nodes(t)
        result+=text(966,595,'Illustrated 2-of-4 layout',25,MUTED,anchor='middle')
        return result
    if i==3:
        result=heading(['Two nodes offline.','Still a way back.'],['Recover from the remaining parts','with your saved receipt and key.'],'03 / RECOVER AND VERIFY')
        result+=nodes(t,True)
        result+=text(966,595,'2 available. Enough to recover.',25,LEAF,anchor='middle')
        return result
    result=heading(['Keep your key.','Keep your way home.'],['Save the signed recovery receipt.','Keep the recovery key separately.'],'YOUR RECOVERY STARTS BEFORE A FAILURE')
    result+=card(782,220,166,234)+card(987,220,166,234)
    result+=file_icon(865,319,.8)+text(865,414,'RECEIPT',19,LEAF,anchor='middle')
    result+=key_icon(1069,310,1)+text(1070,414,'KEY',19,LEAF,anchor='middle')
    result+=text(968,547,'wildbloom.forgesworn.dev',27,PAPER,anchor='middle')
    result+=text(968,586,'Public preview • Bring your own storage',19,MUTED,anchor='middle')
    return result

def svg(time):
    result=f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}"><defs><radialGradient id="glow"><stop stop-color="#2e563b"/><stop offset="1" stop-color="{INK}"/></radialGradient><pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#8fa27b" opacity=".17"/></pattern></defs><rect width="1280" height="720" fill="{INK}"/><ellipse cx="1070" cy="340" rx="540" ry="550" fill="url(#glow)"/><rect width="1280" height="720" fill="url(#dots)"/>'
    result+=leaf(93,51,.54)+text(122,82,'Wildbloom',32,PAPER,'Georgia')
    result+=text(1208,78,'A FILE’S WAY HOME',17,MUTED,anchor='end')
    result+=line(72,111,1208,111,'#46634b',1)
    for i,(start,end) in enumerate(SCENES):
        opacity=(1 if i==0 else ease((time-start)/.55))*(1 if i==4 else ease((end-time)/.55))
        if opacity>0:
            result+=group(scene(i,time-start),opacity, f'translate(0 {(1-ease((time-start)/.8))*13:.3f})')
    result+=line(72,650,1208,650,'#46634b',1)
    result+=line(72,650,72+1136*clamp(time/DURATION),650,LEAF,2)
    result+=text(72,687,'Encrypted first. Distributed by you.',20,MUTED)
    result+=text(1208,687,'Illustration • Not a live storage test',18,MUTED,anchor='end')
    return result+'</svg>'

if __name__=='__main__':
    for name,instant in [('poster',2.5),('encrypt',7.3),('parts',13.5),('recover',20.5),('receipt',28.5)]:
        if name!='poster' and '--stills' not in sys.argv: continue
        source=svg(instant)
        if '--stills' in sys.argv: (ROOT/f'{name}.svg').write_text(source)
        subprocess.run(['rsvg-convert','-o',str(ROOT/f'{name}.png')],input=source.encode(),check=True)
    if '--stills' in sys.argv: sys.exit(0)
    encoder=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate',str(FPS),'-vcodec','png','-i','-','-an','-c:v','libx264','-preset','slow','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart','-metadata','title=Wildbloom: a file’s way home','-metadata','comment=Illustrated 2-of-4 recovery. No live storage test.','-f','mp4',str(ROOT/'wildbloom-a-files-way-home.mp4')],stdin=subprocess.PIPE)
    try:
        for frame in range(FPS*DURATION):
            rendered=subprocess.run(['rsvg-convert'],input=svg(frame/FPS).encode(),stdout=subprocess.PIPE,check=True)
            encoder.stdin.write(rendered.stdout)
            if frame%(FPS*4)==0: print(f'Rendered {frame//FPS}/{DURATION} seconds',flush=True)
    finally: encoder.stdin.close()
    if encoder.wait(): raise SystemExit('Video encoder failed')
    print('Film rendered.',flush=True)
