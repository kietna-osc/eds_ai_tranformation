"""Upload the source image into the group's document library."""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timezone
from pathlib import PurePosixPath

from app.graph.client import GraphClient
from app.schemas import UploadedFile

# Characters SharePoint rejects in a file name.
_ILLEGAL = re.compile(r'[\\/:*?"<>|#%&{}~]+')


def safe_filename(original: str | None, default_ext: str = ".jpg") -> str:
    """Timestamp-prefixed, SharePoint-safe name; collisions are practically impossible."""
    stem, ext = "", default_ext
    if original:
        path = PurePosixPath(unicodedata.normalize("NFKC", original).replace("\\", "/"))
        stem = _ILLEGAL.sub("", path.stem).strip()[:60]
        if path.suffix:
            ext = _ILLEGAL.sub("", path.suffix)[:10]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    return f"{stamp}-{stem}{ext}" if stem else f"{stamp}{ext}"


async def upload_image(
    graph: GraphClient,
    group_id: str,
    folder: str,
    filename: str,
    content: bytes,
) -> UploadedFile:
    """Simple upload; fine up to ~250 MB, far above any label photo."""
    path = f"/groups/{group_id}/drive/items/root:/{folder}/{filename}:/content"
    item = await graph.request(
        "PUT",
        path,
        step="upload image",
        headers={"Content-Type": "application/octet-stream"},
        content=content,
    )
    return UploadedFile(name=item.get("name", filename), web_url=item["webUrl"])
