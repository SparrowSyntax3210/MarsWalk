"""Turn the Ruby mascot picture into the small image the floating button uses.

    python tools/prepare-mascot.py path\\to\\your-mascot.png

Crops the largest centered square, resizes it to 256x256 and writes
frontend/public/assets/ruby-mascot.webp. The page shows it inside a circle,
so the square's corners are cut off by CSS, not here.

Needs Pillow (already installed in python/ruby_voice/.venv).
"""

import sys
from pathlib import Path

from PIL import Image

SIZE = 256
OUT = Path(__file__).resolve().parent.parent / "frontend" / "public" / "assets" / "ruby-mascot.webp"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    source = Path(sys.argv[1])
    if not source.is_file():
        print(f"File not found: {source}")
        return 1

    with Image.open(source) as image:
        image = image.convert("RGBA")
        width, height = image.size
        side = min(width, height)
        left = (width - side) // 2
        top = (height - side) // 2
        square = image.crop((left, top, left + side, top + side))
        square = square.resize((SIZE, SIZE), Image.LANCZOS)
        OUT.parent.mkdir(parents=True, exist_ok=True)
        square.save(OUT, "WEBP", quality=88, method=6)

    print(f"Wrote {OUT} ({OUT.stat().st_size // 1024} KB, {SIZE}x{SIZE}) from {width}x{height}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
