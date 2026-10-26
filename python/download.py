import ssl
import _ssl

if not hasattr(ssl, "OPENSSL_VERSION"):
    ssl.OPENSSL_VERSION = _ssl.OPENSSL_VERSION

from pathlib import Path
from urllib.parse import urljoin, urlparse
import json
import re
import time

import requests
from bs4 import BeautifulSoup
from tqdm import tqdm

OUT_DIR = Path("./mars_datasets")
OUT_DIR.mkdir(parents=True, exist_ok=True)

SESSION = requests.Session()
SESSION.headers.update(
    {"User-Agent": "MarsMissionDownloader/1.0 (educational research)"}
)

TIMEOUT = (30, 90)  # connect timeout, per-read timeout
CHUNK_SIZE = 1024 * 1024


# For pages that publish download links rather than a stable file URL,
# the script selects matching links by their visible text or URL.
PAGE_DOWNLOADS = [
    {
        "name": "sim3292_geology",
        "page": "https://pubs.usgs.gov/sim/3292/",
        "match": r"database.*\.zip|\.zip.*database",
        "filename": "sim3292_database.zip",
    },
    {
        "name": "mgd3_equatorial_dunes",
        "page": "https://pubs.usgs.gov/of/2007/1158/",
        "match": r"shapefiles\.zip",
        "filename": "mgd3_equatorial_shapefiles.zip",
    },
    {
        "name": "mgd3_north_polar_dunes",
        "page": "https://pubs.usgs.gov/of/2010/1170/",
        "match": r"shapefiles\.zip|gis.*\.zip",
        "filename": "mgd3_north_polar_gis.zip",
    },
    {
        "name": "mgd3_south_polar_dunes",
        "page": "https://pubs.usgs.gov/of/2012/1259/",
        "match": r"SP_GIS_Download_Package.*\.zip",
        "filename": "mgd3_south_polar_gis.zip",
    },
    {
        "name": "swim_products",
        "page": "https://swim.psi.edu/SWIM4MIMProducts.php",
        "match": r"\.(zip|tif|tiff)(\?|$)",
        "filename": None,  # use the name from each link
    },
    {
        "name": "tes_thermal_inertia",
        "page": "https://tes.mars.asu.edu/products/",
        "match": r"thermal.?inertia.*\.(zip|tar|gz|img|dat|bin)",
        "filename": None,
    },
]


DIRECT_DOWNLOADS = [
    {
        "name": "hrsc_mola_dem",
        "url": (
            "https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/"
            "Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"
        ),
        "filename": "Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif",
    },
    {
        "name": "ai4mars_merged",
        "url": (
            "https://zenodo.org/records/15995036/files/"
            "ai4mars-dataset-merged-0.6.zip?download=1"
        ),
        "filename": "ai4mars-dataset-merged-0.6.zip",
    },
]


def get_page_links(page_url):
    response = SESSION.get(page_url, timeout=TIMEOUT)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    links = []

    for anchor in soup.select("a[href]"):
        href = urljoin(page_url, anchor["href"])
        label = " ".join(anchor.get_text(" ", strip=True).split())
        links.append((label, href))

    return links


def already_downloaded(filename):
    """Skip a matching complete file already in the output folder."""
    path = OUT_DIR / filename
    return path.exists() and path.stat().st_size > 0


def download_file(url, filename):
    destination = OUT_DIR / filename
    partial = destination.with_name(destination.name + ".part")

    if already_downloaded(filename):
        print(f"Already downloaded; skipping: {filename}")
        return True

    for attempt in range(1, 4):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            headers = {}

            if offset:
                headers["Range"] = f"bytes={offset}-"
                print(f"Resuming {filename} from {offset:,} bytes")
            else:
                print(f"Starting {filename}")

            with SESSION.get(
                url,
                headers=headers,
                stream=True,
                timeout=TIMEOUT,
            ) as response:

                if response.status_code == 416:
                    # The server says the requested range is beyond the file.
                    # Keep an existing non-empty partial file as the result.
                    if partial.exists() and partial.stat().st_size > 0:
                        partial.replace(destination)
                        print(f"Finished: {filename}")
                        return True
                    partial.unlink(missing_ok=True)
                    raise requests.RequestException("Server rejected the resume range")

                response.raise_for_status()

                content_type = response.headers.get("Content-Type", "").lower()

                if "text/html" in content_type:
                    raise ValueError("URL returned an HTML page, not a data file")

                # Append only if the server honored the Range request.
                append = offset > 0 and response.status_code == 206
                if offset > 0 and not append:
                    offset = 0

                total = None
                content_range = response.headers.get("Content-Range", "")
                if "/" in content_range:
                    try:
                        total = int(content_range.rsplit("/", 1)[1])
                    except ValueError:
                        pass

                if total is None:
                    content_length = response.headers.get("Content-Length")
                    if content_length and content_length.isdigit():
                        total = (
                            offset + int(content_length)
                            if append
                            else int(content_length)
                        )

                mode = "ab" if append else "wb"
                initial = offset if append else 0

                with partial.open(mode) as output, tqdm(
                    total=total,
                    initial=initial,
                    unit="B",
                    unit_scale=True,
                    unit_divisor=1024,
                    desc=filename,
                    mininterval=0.5,
                ) as bar:
                    for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                        if chunk:
                            output.write(chunk)
                            bar.update(len(chunk))

            if not partial.exists() or partial.stat().st_size == 0:
                raise IOError("Downloaded file is empty")

            partial.replace(destination)
            print(f"Saved {filename} " f"({destination.stat().st_size:,} bytes)")
            return True

        except KeyboardInterrupt:
            print(
                f"\nStopped. Partial download kept at:\n{partial}\n"
                "Run this script again to resume if the server supports it."
            )
            return False

        except (requests.RequestException, OSError, ValueError) as error:
            print(f"\nAttempt {attempt}/3 failed for {filename}: {error}")
            if attempt < 3:
                time.sleep(attempt * 5)

    print(f"Failed: {filename}. Any partial download was kept.")
    return False


def download_robbins_craters():
    """
    Download the Robbins crater records from the USGS planetary vector API
    as GeoJSON. This is a GIS-ready alternative to the older CSV endpoint.
    """
    filename = "robbins_craters.geojson"
    destination = OUT_DIR / filename

    if already_downloaded(filename):
        print(f"Already downloaded; skipping: {filename}")
        return True

    next_url = (
        "https://astrogeology.usgs.gov/pygeoapi/collections/"
        "mars/robbinsv1/items?f=json&limit=1000"
    )
    first_page = True
    count = 0

    try:
        with destination.open("w", encoding="utf-8") as output:
            output.write('{"type":"FeatureCollection","features":[')

            while next_url:
                response = SESSION.get(next_url, timeout=TIMEOUT)
                response.raise_for_status()
                page = response.json()

                features = page.get("features", [])
                for feature in features:
                    if not first_page or count:
                        output.write(",")
                    output.write(json.dumps(feature, separators=(",", ":")))
                    count += 1

                first_page = False

                next_url = None
                for link in page.get("links", []):
                    if link.get("rel") == "next" and link.get("href"):
                        next_url = urljoin(response.url, link["href"])
                        break

                print(f"Robbins crater features received: {count:,}")

                # Avoid a tight request loop against the USGS service.
                if next_url:
                    time.sleep(0.25)

            output.write("]}")

        if count == 0:
            destination.unlink(missing_ok=True)
            print("The Robbins API returned no features.")
            return False

        print(f"Saved {filename} with {count:,} crater features")
        return True

    except KeyboardInterrupt:
        destination.unlink(missing_ok=True)
        print("\nStopped Robbins download. Run it again to restart.")
        return False
    except (requests.RequestException, ValueError, OSError) as error:
        destination.unlink(missing_ok=True)
        print(f"Robbins download failed: {error}")
        return False


def run_page_download(spec):
    print(f"\n=== {spec['name']} ===")

    try:
        links = get_page_links(spec["page"])
    except requests.RequestException as error:
        print(f"Could not open source page: {error}")
        print(f"Source page: {spec['page']}")
        return False

    pattern = re.compile(spec["match"], re.IGNORECASE)
    candidates = [
        (label, url) for label, url in links if pattern.search(f"{label} {url}")
    ]

    # Remove duplicate URLs.
    unique = []
    seen = set()
    for label, url in candidates:
        if url not in seen:
            unique.append((label, url))
            seen.add(url)

    if not unique:
        print("No matching download link found on this source page.")
        print(f"Open the page to choose the file: {spec['page']}")
        return False

    success = True
    for index, (label, url) in enumerate(unique, start=1):
        if spec["filename"] and len(unique) == 1:
            filename = spec["filename"]
        else:
            filename = Path(urlparse(url).path).name
            if not filename:
                filename = f"{spec['name']}_{index}.dat"

        print(f"Found: {label or filename}")
        if not download_file(url, filename):
            success = False
        time.sleep(2)

    return success


def main():
    failures = []

    print(f"Download folder: {OUT_DIR.resolve()}")

    for item in DIRECT_DOWNLOADS:
        print(f"\n=== {item['name']} ===")
        if not download_file(item["url"], item["filename"]):
            failures.append(item["name"])

    print("\n=== robbins_craters ===")
    if not download_robbins_craters():
        failures.append("robbins_craters")

    for spec in PAGE_DOWNLOADS:
        if not run_page_download(spec):
            failures.append(spec["name"])

    print("\nDownload run complete.")
    print(f"Files are in: {OUT_DIR.resolve()}")

    if failures:
        print("\nThese sources need attention:")
        for name in failures:
            print(f"  - {name}")
        print(
            "\nA source may be temporarily unavailable, or its download "
            "page may have changed. Completed files remain in the folder."
        )
    else:
        print("All configured downloads completed.")


if __name__ == "__main__":
    main()
