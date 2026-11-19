"""Restore browser dependencies from the checked-in version and checksum manifest."""

import argparse
import base64
import hashlib
import io
import json
import tarfile
import urllib.request
from pathlib import Path


MANIFEST = Path(__file__).resolve().parents[1] / "assets/vendor/manifest.json"


def install(output):
    for package, dependency in json.loads(MANIFEST.read_text()).items():
        files = dependency["files"]
        missing = {
            digest: file
            for file, digest in files.items()
            if not (output / file).is_file()
            or hashlib.sha256((output / file).read_bytes()).hexdigest() != digest
        }
        if not missing:
            continue
        version = dependency["version"]
        url = f"https://registry.npmjs.org/{package}/-/{package}-{version}.tgz"
        with urllib.request.urlopen(url, timeout=30) as response:
            content = response.read(16 * 1024**2)
        expected = dependency["integrity"]
        actual = "sha512-" + base64.b64encode(hashlib.sha512(content).digest()).decode()
        if actual != expected:
            raise ValueError(f"{package} dependency archive checksum mismatch")
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
            for member in archive:
                if not member.isfile() or member.size > 8 * 1024**2:
                    continue
                with archive.extractfile(member) as stream:
                    data = stream.read()
                file = missing.pop(hashlib.sha256(data).hexdigest(), None)
                if file is not None:
                    dest = output / file
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(data)
                if not missing:
                    break
        if missing:
            raise ValueError(f"{package} dependency files missing from release")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=MANIFEST.parent)
    install(parser.parse_args().output)
