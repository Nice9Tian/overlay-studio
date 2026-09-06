import sys
import os
from faster_whisper import WhisperModel

def main():
    if len(sys.argv) < 3:
        print("Usage: python stt-faster-whisper.py <wav_file> <srt_file> [language]")
        sys.exit(1)
        
    wav_file = sys.argv[1]
    srt_file = sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    
    model_size = os.environ.get("OVERLAY_STT_MODEL", "large-v3")
    
    try:
        model = WhisperModel(model_size, device="cuda", compute_type="float16")
    except Exception as e:
        print(f"CUDA failed, falling back to CPU: {e}")
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        
    segments, info = model.transcribe(wav_file, language=language)
    
    def format_timestamp(seconds: float) -> str:
        h = int(seconds // 3600)
        m = int((seconds % 3600) // 60)
        s = int(seconds % 60)
        ms = int((seconds - int(seconds)) * 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
    
    with open(srt_file, "w", encoding="utf-8") as f:
        for i, segment in enumerate(segments, start=1):
            f.write(f"{i}\n")
            f.write(f"{format_timestamp(segment.start)} --> {format_timestamp(segment.end)}\n")
            f.write(f"{segment.text.strip()}\n\n")

if __name__ == "__main__":
    main()
