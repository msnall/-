"""Build a 剪映 (JianYing) draft from a timeline spec written by scripts/export-capcut.mjs.

    tools/python/python.exe scripts/capcut/build_draft.py <spec.json> <draft-root-folder>

Uses pyJianYingDraft (version pinned in requirements-capcut.txt). All geometry arrives already converted to
剪映 units, so this file only creates tracks/segments, text styles and keyframes. Prints one JSON summary line.
"""
import json
import os
import sys

import pyJianYingDraft as jy
from pyJianYingDraft import (AudioSegment, ClipSettings, KeyframeProperty, TextBackground, TextSegment, TextStyle,
                             Timerange, TrackSpec, TrackType, VideoSegment)

spec = json.load(open(sys.argv[1], encoding="utf8"))
root = os.path.abspath(sys.argv[2])
os.makedirs(root, exist_ok=True)

canvas = spec["canvas"]
folder = jy.DraftFolder(root)
script = folder.create_draft(spec["name"], canvas["width"], canvas["height"], canvas["fps"], allow_replace=True)

summary = {"tracks": [], "skipped": spec.get("skipped", [])}


def rgb(hex_color):
    h = hex_color.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


for lane in spec["lanes"]:
    kind = lane["kind"]
    ttype = {"video": TrackType.video, "text": TrackType.text, "audio": TrackType.audio}[kind]
    script.append_track(TrackSpec(ttype, lane["name"]))
    count = 0
    for s in lane["segments"]:
        at = Timerange(s["startUs"], s["durUs"])
        if kind == "video":
            c = s.get("clip", {})
            clip = ClipSettings(scale_x=c.get("scaleX", 1.0), scale_y=c.get("scaleY", 1.0),
                                transform_x=c.get("x", 0.0), transform_y=c.get("y", 0.0), alpha=c.get("alpha", 1.0))
            src = Timerange(s["srcStartUs"], s["durUs"]) if s.get("srcStartUs") is not None else None
            try:
                seg = VideoSegment(s["file"], at, source_timerange=src, volume=s.get("volume", 1.0), clip_settings=clip)
            except ValueError as error:
                # The master video's length is a whole number of frames, the library reads it rounded down to the millisecond; the last
                # segment can overshoot by a fraction of a frame. Trim that sliver; anything bigger is a real problem.
                import re
                m = re.search(r"\((\d+)\)", str(error))
                if not m or src is None or "素材时长" not in str(error):
                    raise
                room = int(m.group(1)) - s["srcStartUs"]
                if room <= 0 or s["durUs"] - room > 100000:
                    raise
                at = Timerange(s["startUs"], room)
                src = Timerange(s["srcStartUs"], room)
                seg = VideoSegment(s["file"], at, source_timerange=src, volume=s.get("volume", 1.0), clip_settings=clip)
            for kf in s.get("scaleKeyframes", []):
                # values are multipliers of the base scale; uniform clips use one keyframe list
                if abs(c.get("scaleX", 1.0) - c.get("scaleY", 1.0)) < 1e-9:
                    seg.add_keyframe(KeyframeProperty.uniform_scale, kf["tUs"], c.get("scaleX", 1.0) * kf["value"])
                else:
                    seg.add_keyframe(KeyframeProperty.scale_x, kf["tUs"], c.get("scaleX", 1.0) * kf["value"])
                    seg.add_keyframe(KeyframeProperty.scale_y, kf["tUs"], c.get("scaleY", 1.0) * kf["value"])
        elif kind == "text":
            st = s["style"]
            bg = s.get("background")
            seg = TextSegment(
                s["text"], at,
                style=TextStyle(size=st["size"], bold=st.get("bold", True), color=rgb(st["color"]), align=1,
                                auto_wrapping=True, max_line_width=st.get("maxLineWidth", 0.82)),
                clip_settings=ClipSettings(transform_x=s["x"], transform_y=s["y"]),
                background=TextBackground(color=bg["color"], alpha=bg["alpha"], style=1, round_radius=0.25,
                                          height=0.18, width=0.18, horizontal_offset=0.5, vertical_offset=0.5) if bg else None,
            )
        else:
            seg = AudioSegment(s["file"], at, volume=s.get("volume", 1.0))
        script.add_segment(seg, lane["name"])
        count += 1
    summary["tracks"].append({"name": lane["name"], "kind": kind, "segments": count})

script.save()
summary["draft"] = os.path.join(root, spec["name"])
summary["durationUs"] = script.duration
print("SUMMARY " + json.dumps(summary, ensure_ascii=False))
