import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

let detectedEngine = null;

export async function probeDuration(file) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      file
    ]);
    const duration = parseFloat(stdout.trim());
    return isNaN(duration) ? 0 : duration;
  } catch (e) {
    throw new Error(`Failed to probe duration: ${e.message}`);
  }
}

export async function extractWav(inFile, outWav) {
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', inFile,
      '-vn', '-ac', '1', '-ar', '16000',
      '-f', 'wav', outWav
    ]);
  } catch (e) {
    throw new Error(`Failed to extract WAV: ${e.message}`);
  }
}

export async function detectEngine() {
  if (detectedEngine) return detectedEngine;

  if (process.env.OVERLAY_STT_CMD) {
    detectedEngine = {
      available: true,
      engine: 'custom',
      cmdTemplate: process.env.OVERLAY_STT_CMD
    };
    return detectedEngine;
  }

  try {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const sttJson = join(localAppData, 'overlay-studio', 'stt.json');
      if (fs.existsSync(sttJson)) {
        const config = JSON.parse(fs.readFileSync(sttJson, 'utf8'));
        if (config.cmd) {
          detectedEngine = {
            available: true,
            engine: 'custom',
            cmdTemplate: config.cmd
          };
          return detectedEngine;
        }
      }
    }
  } catch (e) {
  }

  const pythons = [
    'C:\\Users\\admin\\anaconda3\\envs\\cuda_Vit\\python.exe',
    'python'
  ];
  for (const py of pythons) {
    try {
      await execFileAsync(py, ['-c', 'import faster_whisper']);
      detectedEngine = {
        available: true,
        engine: 'faster-whisper',
        python: py
      };
      return detectedEngine;
    } catch (e) {
    }
  }

  detectedEngine = {
    available: false,
    engine: null,
    hint: "这台机器没有语音识别引擎。装一个:在 conda 环境 cuda_Vit 里 pip install faster-whisper(显卡 RTX 3080 可用 CUDA);或设置环境变量 OVERLAY_STT_CMD 指向任意能把 wav 转成 srt 的命令。"
  };
  return detectedEngine;
}

export async function transcribe(file, language) {
  const engineInfo = await detectEngine();
  if (!engineInfo.available) {
    throw new Error(engineInfo.hint);
  }

  const duration = await probeDuration(file);
  const tempDir = join(tmpdir(), 'overlay-studio', 'stt');
  fs.mkdirSync(tempDir, { recursive: true });
  
  const id = Date.now() + Math.random().toString(36).substring(2, 7);
  const wavFile = join(tempDir, `${id}.wav`);
  const srtFile = join(tempDir, `${id}.srt`);

  try {
    await extractWav(file, wavFile);
    
    if (engineInfo.engine === 'custom') {
      let cmd = engineInfo.cmdTemplate
        .replace(/\{wav\}/g, `"${wavFile}"`)
        .replace(/\{srt\}/g, `"${srtFile}"`)
        .replace(/\{lang\}/g, language ? `"${language}"` : '""');
      
      const args = ['/c', cmd];
      await new Promise((resolve, reject) => {
        const proc = spawn('cmd.exe', args, { windowsHide: true, shell: false });
        proc.on('error', reject);
        proc.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(`Custom STT command exited with code ${code}`));
        });
      });
    } else if (engineInfo.engine === 'faster-whisper') {
      const script = fileURLToPath(new URL('./stt-faster-whisper.py', import.meta.url));
      const args = [script, wavFile, srtFile];
      if (language) args.push(language);
      
      await new Promise((resolve, reject) => {
        const proc = spawn(engineInfo.python, args, { windowsHide: true, shell: false });
        proc.on('error', reject);
        proc.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(`faster-whisper exited with code ${code}`));
        });
      });
    }
    
    if (!fs.existsSync(srtFile)) {
      throw new Error("STT engine finished but no SRT file was generated.");
    }
    const srtText = fs.readFileSync(srtFile, 'utf8');
    const lines = srtText.split('\n\n').filter(b => b.trim().length > 0).length;

    return {
      srt_text: srtText,
      engine: engineInfo.engine,
      seconds: duration,
      lines: lines
    };
  } finally {
    fs.rmSync(wavFile, { force: true });
    fs.rmSync(srtFile, { force: true });
  }
}
