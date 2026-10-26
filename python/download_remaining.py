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

TIMEOUT = (30, 120)
CHUNK_SIZE = 1024 * 1024


def download_file(url, filename):
    """Download with a progress bar and resume a partial .part file."""
    destination = OUT_DIR / filename
    partial = destination.with_name(destination.name + ".part")

    if destination.exists() and destination.stat().st_size > 0:
        print(f"Already downloaded; skipping: {filename}")
        return True

    for attempt in range(1, 4):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            headers = {"Range": f"bytes={offset}-"} if offset else {}

            if offset:
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
                    if partial.exists() and partial.stat().st_size:
                        partial.replace(destination)
                        print(f"Finished: {filename}")
                        return True
                    partial.unlink(missing_ok=True)
                    raise requests.RequestException("Server rejected the resume range")

                response.raise_for_status()

                if "text/html" in response.headers.get("Content-Type", "").lower():
                    raise ValueError("URL returned a webpage, not a data file")

                append = offset > 0 and response.status_code == 206
                if offset and not append:
                    offset = 0

                total = None
                content_range = response.headers.get("Content-Range", "")
                if "/" in content_range:
                    try:
                        total = int(content_range.rsplit("/", 1)[1])
                    except ValueError:
                        pass

                if total is None:
                    length = response.headers.get("Content-Length")
                    if length and length.isdigit():
                        total = offset + int(length) if append else int(length)

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
                    for chunk in response.iter_content(CHUNK_SIZE):
                        if chunk:
                            output.write(chunk)
                            bar.update(len(chunk))

            if not partial.exists() or partial.stat().st_size == 0:
                raise IOError("Download is empty")

            partial.replace(destination)
            print(f"Saved {filename} ({destination.stat().st_size:,} bytes)")
            return True

        except KeyboardInterrupt:
            print(f"\nStopped. Partial file kept: {partial}")
            return False
        except (requests.RequestException, OSError, ValueError) as error:
            print(f"\nAttempt {attempt}/3 failed: {error}")
            if attempt < 3:
                time.sleep(attempt * 5)

    print(f"Failed: {filename}. Partial file, if any, was kept.")
    return False


def download_robbins():
    """
    Fetch Robbins crater features in offset pages.
    Uses the API base URL for each page instead of its malformed next link.
    """
    output_path = OUT_DIR / "robbins_craters.geojson"
    temp_path = OUT_DIR / "robbins_craters.geojson.part"

    if output_path.exists() and output_path.stat().st_size:
        print("Already downloaded; skipping: robbins_craters.geojson")
        return True

    base_url = (
        "https://astrogeology.usgs.gov/pygeoapi/collections/" "mars/robbinsv1/items"
    )
    page_size = 1000
    offset = 0
    total_features = 384343
    received = 0

    try:
        with temp_path.open("w", encoding="utf-8") as output:
            output.write('{"type":"FeatureCollection","features":[')

            with tqdm(
                total=total_features,
                unit="features",
                desc="Robbins crater records",
                mininterval=0.5,
            ) as bar:
                while True:
                    params = {
                        "f": "json",
                        "limit": page_size,
                        "offset": offset,
                    }

                    response = SESSION.get(
                        base_url,
                        params=params,
                        timeout=TIMEOUT,
                    )
                    response.raise_for_status()
                    page = response.json()
                    features = page.get("features", [])

                    if not features:
                        break

                    for feature in features:
                        if received:
                            output.write(",")
                        output.write(json.dumps(feature, separators=(",", ":")))
                        received += 1

                    bar.update(len(features))
                    offset += len(features)

                    if len(features) < page_size:
                        break

                    time.sleep(0.2)

            output.write("]}")

        if received == 0:
            temp_path.unlink(missing_ok=True)
            print("Robbins API returned no records.")
            return False

        temp_path.replace(output_path)
        print(f"Saved {output_path.name}: {received:,} features")
        return True

    except KeyboardInterrupt:
        print(f"\nStopped. Partial API output kept at: {temp_path}")
        return False
    except (requests.RequestException, ValueError, OSError) as error:
        temp_path.unlink(missing_ok=True)
        print(f"Robbins download failed: {error}")
        return False


def find_links(page_url):
    """Return (label, absolute URL) pairs from a web page."""
    response = SESSION.get(page_url, timeout=TIMEOUT)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    links = []

    for anchor in soup.select("a[href]"):
        href = urljoin(page_url, anchor["href"])
        label = " ".join(anchor.get_text(" ", strip=True).split())
        links.append((label, href))

    return links


def download_mgd3_north():
    # USGS publication page for MGD3 MC-1, the north polar release.
    page_url = "https://pubs.usgs.gov/publication/ofr20101170"
    print("\n=== MGD3 north polar dunes ===")

    try:
        links = find_links(page_url)
    except requests.RequestException as error:
        print(f"Could not open USGS page: {error}")
        print(f"Open this page manually: {page_url}")
        return False

    candidates = []
    for label, url in links:
        text = f"{label} {url}".lower()
        if ".zip" in url.lower() and (
            "database" in text or "entire" in text or "gis" in text
        ):
            candidates.append((label, url))

    if not candidates:
        # Some USGS pages call it simply "Entire database ZIP file."
        candidates = [
            (label, url)
            for label, url in links
            if ".zip" in url.lower() and "zip" in label.lower()
        ]

    if not candidates:
        print("No ZIP link was exposed on the publication page.")
        print(f"Open this page and choose its database ZIP: {page_url}")
        return False

    # Prefer the complete database package if present.
    label, url = next(
        (
            pair
            for pair in candidates
            if "entire" in pair[0].lower() or "database" in pair[0].lower()
        ),
        candidates[0],
    )

    print(f"Selected: {label or url}")
    return download_file(url, "mgd3_north_polar_database.zip")


def download_swim():
    # The SWIM server timed out previously. This retries the page and any
    # directly linked GeoTIFF/ZIP products it exposes.
    page_url = "https://swim.psi.edu/SWIM4MIMProducts.php"
    print("\n=== SWIM ice products ===")

    try:
        links = find_links(page_url)
    except requests.RequestException as error:
        print(f"SWIM site is still unreachable: {error}")
        print(f"Try this page later in a browser: {page_url}")
        return False

    candidates = []
    for label, url in links:
        path = urlparse(url).path.lower()
        if path.endswith((".zip", ".tif", ".tiff")):
            candidates.append((label, url))

    # De-duplicate URLs.
    unique = []
    seen = set()
    for label, url in candidates:
        if url not in seen:
            unique.append((label, url))
            seen.add(url)

    if not unique:
        print("The SWIM page exposed no direct ZIP or GeoTIFF links.")
        print(
            "Choose the desired GeoTIFF product on the page, download it in "
            "your browser, and save it into the mars_datasets folder."
        )
        print(page_url)
        return False

    success = True
    for index, (label, url) in enumerate(unique, start=1):
        filename = Path(urlparse(url).path).name
        if not filename:
            filename = f"swim_product_{index}.dat"

        print(f"SWIM product: {label or filename}")
        if not download_file(url, filename):
            success = False
        time.sleep(2)

    return success


def main():
    failures = []

    print(f"Download folder: {OUT_DIR.resolve()}")

    print("\n=== Robbins crater database ===")
    if not download_robbins():
        failures.append("Robbins crater database")

    print("\n=== MGD3 north polar dunes ===")
    if not download_mgd3_north():
        failures.append("MGD3 north polar dunes")

    print("\n=== SWIM ice products ===")
    if not download_swim():
        failures.append("SWIM ice products")

    print("\n=== TES thermal inertia archive ===")
    tes_url = (
        "https://pds-geosciences.wustl.edu/mgs/" "mgs-m-tes-5-timap-v1/mgst_9001.zip"
    )
    if not download_file(tes_url, "tes_thermal_inertia_maps.zip"):
        failures.append("TES thermal inertia archive")

    print(f"\nFinished. Files are in: {OUT_DIR.resolve()}")
    if failures:
        print("\nStill incomplete:")
        for name in failures:
            print(f"  - {name}")
    else:
        print("All four downloads completed.")


if __name__ == "__main__":
    main()
