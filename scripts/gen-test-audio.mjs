import { run, FFMPEG } from "../src/audio/ffmpeg.js";
const out = process.argv[2] ?? "data/audio/test.wav";
// ۵ ثانیه صدا، ۸ ثانیه سکوت، ۵ ثانیه صدا، ۱۲ ثانیه سکوت، ۵ ثانیه صدا
const filter =
  "sine=f=220:d=5,volume=0.3[a];" +
  "anullsrc=r=44100:cl=mono,atrim=0:8[s1];" +
  "sine=f=330:d=5,volume=0.3[b];" +
  "anullsrc=r=44100:cl=mono,atrim=0:12[s2];" +
  "sine=f=440:d=5,volume=0.3[c];" +
  "[a][s1][b][s2][c]concat=n=5:v=0:a=1[out]";
const r = await run(FFMPEG, ["-hide_banner","-y","-filter_complex",filter,"-map","[out]","-ar","44100","-ac","1",out]);
console.log(r.code === 0 ? `ساخته شد: ${out}` : r.stderr.slice(-800));
