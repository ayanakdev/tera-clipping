import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const variants = [
  { name: 'Poppins b0', fn: 'Poppins', b: 0 },
  { name: 'Poppins b-1', fn: 'Poppins', b: -1 },
  { name: 'Poppins EB b0', fn: 'Poppins ExtraBold', b: 0 },
  { name: 'Poppins EB b-1', fn: 'Poppins ExtraBold', b: -1 },
  { name: 'Poppins-ExtraBold b0', fn: 'Poppins-ExtraBold', b: 0 },
  { name: 'Poppins-ExtraBold b-1', fn: 'Poppins-ExtraBold', b: -1 },
  { name: 'Anton b0', fn: 'Anton', b: 0 },
  { name: 'Bebas b0', fn: 'Bebas Neue', b: 0 },
];
const styles = variants
  .map((v, i) => `Style: S${i},${v.fn},50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,${v.b},0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`)
  .join('\n');
const events = variants
  .map((v, i) => `Dialogue: 0,0:00:00.00,0:00:05.00,S${i},,0,0,0,,{\\an7\\pos(30,${40 + i * 90})\\fnPoppins\\b0\\fs20}${v.name}`)
  .join('\n') + '\n' +
  variants
  .map((v, i) => `Dialogue: 0,0:00:00.00,0:00:05.00,S${i},,0,0,0,,{\\an7\\pos(30,${65 + i * 90})}THIS IS INSANE RIGHT NOW`)
  .join('\n');
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
fs.writeFileSync('data/tmp/fontvariants.ass', ass);
execFileSync(ffmpegPath, ['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=#111111:size=1080x1920:rate=30:duration=1','-vf','subtitles=filename=data/tmp/fontvariants.ass:fontsdir=tools/fonts','-frames:v','1','data/tmp/fontvariants.png'], { stdio: 'inherit' });
console.log('done');
