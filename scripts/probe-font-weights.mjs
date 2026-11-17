import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const families = [
  ['Poppins b0', 'Poppins', 0],
  ['Poppins b-1', 'Poppins', -1],
  ['Poppins ExtraBold b0', 'Poppins ExtraBold', 0],
  ['Poppins EB fs100', 'Poppins ExtraBold', 0, 100],
  ['Poppins-Bold b0', 'Poppins-Bold', 0],
  ['Anton b0', 'Anton', 0],
];
const styles = families
  .map(([name, fn, b], i) => `Style: S${i},${fn},50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,${b},0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`)
  .join('\n');
const events = families.map(([name, fn, b, fs], i) => {
  const override = `\\fn${fn}\\b${b}${fs ? `\\fs${fs}` : ''}`;
  return `Dialogue: 0,0:00:00.00,0:00:05.00,S${i},,0,0,0,,{\\an7\\pos(30,${60 + i * 110})${override}}THIS IS INSANE RIGHT NOW`;
}).join('\n');
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
fs.writeFileSync('data/tmp/fonts-only/weights.ass', ass);
execFileSync(ffmpegPath, ['-y','-hide_banner','-loglevel','debug','-f','lavfi','-i','color=c=#111111:size=1080x1920:rate=30:duration=1','-vf','subtitles=filename=data/tmp/fonts-only/weights.ass:fontsdir=data/tmp/fonts-only','-frames:v','1','data/tmp/fonts-only/weights.png'], { stdio: 'inherit' });
