import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const fonts = ['Poppins', 'Poppins ExtraBold', 'Poppins-ExtraBold', 'Anton', 'Bebas Neue', 'Segoe UI'];
const rows = fonts.map((f, i) => `Dialogue: 0,0:00:00.00,0:00:05.00,Caption,,0,0,0,,{\\an5\\pos(540,${150 + i * 220})\\fn${f}\\fs72\\b1}${f}: THIS IS INSANE RIGHT NOW`).join('\n');
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Poppins,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${rows}
`;
fs.writeFileSync('data/tmp/fonttest.ass', ass, 'utf8');
execFileSync(ffmpegPath, ['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=#ffeeee:size=1080x1920:rate=30:duration=1','-vf','subtitles=filename=data/tmp/fonttest.ass:fontsdir=tools/fonts','-frames:v','1','data/tmp/fonttest.png'], { stdio: 'inherit' });
console.log('done');
