import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

fs.mkdirSync('data/tmp/fonts-only', { recursive: true });
fs.copyFileSync('tools/fonts/Poppins-ExtraBold.ttf', 'data/tmp/fonts-only/Poppins-ExtraBold.ttf');

const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: A,Poppins ExtraBold,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: B,Poppins,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: C,Poppins ExtraBold,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,A,,0,0,0,,{\\an7\\pos(30,80)}THIS IS INSANE RIGHT NOW
Dialogue: 0,0:00:00.00,0:00:05.00,B,,0,0,0,,{\\an7\\pos(30,180)}THIS IS INSANE RIGHT NOW
Dialogue: 0,0:00:00.00,0:00:05.00,C,,0,0,0,,{\\an7\\pos(30,280)}THIS IS INSANE RIGHT NOW
`;
fs.writeFileSync('data/tmp/fonts-only/test.ass', ass);
execFileSync(
  ffmpegPath,
  [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=#111111:size=1080x1920:rate=30:duration=1',
    '-vf', 'subtitles=filename=data/tmp/fonts-only/test.ass:fontsdir=data/tmp/fonts-only',
    '-frames:v', '1', 'data/tmp/fonts-only/out.png',
  ],
  { stdio: 'inherit' },
);
console.log('done');
