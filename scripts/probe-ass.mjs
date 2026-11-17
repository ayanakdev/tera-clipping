import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const w = 1080, h = 1920;
const y = 1430;
const boxW = 820, boxH = 150, r = 44;
const bx = w / 2 - boxW / 2, by = y - boxH / 2;
const x0 = bx, y0 = by, x1 = bx + boxW, y1 = by + boxH;
const draw = [
  `m ${x0 + r} ${y0}`,
  `l ${x1 - r} ${y0}`,
  `b ${x1 - r / 2} ${y0} ${x1} ${y0 + r / 2} ${x1} ${y0 + r}`,
  `l ${x1} ${y1 - r}`,
  `b ${x1} ${y1 - r / 2} ${x1 - r / 2} ${y1} ${x1 - r} ${y1}`,
  `l ${x0 + r} ${y1}`,
  `b ${x0 + r / 2} ${y1} ${x0} ${y1 - r / 2} ${x0} ${y1 - r}`,
  `l ${x0} ${y0 + r}`,
  `b ${x0} ${y0 + r / 2} ${x0 + r / 2} ${y0} ${x0 + r} ${y0}`,
].join(' ');
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Poppins,68,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,40,40,40,1
Style: Box,Poppins,68,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: Hook,Caption,52,&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,8,40,40,130,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.20,0:00:02.40,Box,,0,0,0,,{\\an7\\pos(0,0)\\p1\\1c&H00FFFFFF&\\bord0\\shad0}${draw}
Dialogue: 0,0:00:00.20,0:00:02.40,Caption,,0,0,0,,{\\an5\\pos(${w / 2},${y})\\fad(80,60)\\fscx104\\fscy104\\t(0,90,\\fscx100\\fscy100)}THIS IS {\\c&H00C832F5&}INSANE{\\c&H00FFFFFF&} RIGHT NOW
Dialogue: 0,0:00:02.40,0:00:04.60,Caption,,0,0,0,,{\\an5\\pos(${w / 2},${y})\\fad(80,0)}wait {\\c&H00C832F5&}WAIT{\\c&H00FFFFFF&} WAIT... LOOK AT THIS
Dialogue: 0,0:00:00.20,0:00:04.60,Hook,,0,0,0,,{\\an5\\pos(${w / 2},400)\\fad(100,0)}Marlon's cameraman caught him edit farming 😭
`;
fs.mkdirSync('data/tmp', { recursive: true });
fs.writeFileSync('data/tmp/test.ass', ass, 'utf8');
const args = [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'color=c=#777777:size=1080x1920:rate=30:duration=5',
  '-vf', `subtitles=filename=data/tmp/test.ass:fontsdir=tools/fonts`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
  'data/tmp/test-subs.mp4',
];
execFileSync(ffmpegPath, args, { stdio: 'inherit' });
execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '1.2', '-i', 'data/tmp/test-subs.mp4', '-frames:v', '1', 'data/tmp/test-subs.png'], { stdio: 'inherit' });
console.log('done');
