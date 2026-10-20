#!/usr/bin/env python3
"""Builds and signs the "Handoff to PC" iOS Share Sheet shortcut.

  python3 scripts/generate-shortcut.py          -> public/shortcut/handoff-to-pc.shortcut
  python3 scripts/generate-shortcut.py --dev    -> public/shortcut/handoff-to-pc-dev.shortcut (tunnel host)

The install page downloads it as "Handoff to PC.shortcut" (via the link's download attribute).
The main install button links to an iCloud copy instead: after changing the shortcut, add the new
file to the Shortcuts app, share it as an iCloud link, and update the link in public/shortcut/index.html.

Links and text are sent as JSON (they arrive as shareable text on the computer). Without this,
iOS coerces a shared link into a file by downloading the web page, so the computer got an .html file.
Photos, videos and documents are uploaded as files.
"""
import os
import plistlib
import subprocess
import sys

DEV = "--dev" in sys.argv

BASE_ENDPOINT = "https://kljzghiiovsvymixqgrf.supabase.co/functions/v1/shortcut-upload"
ENDPOINT = f"{BASE_ENDPOINT}?host=tunnel.handoffdrop.app" if DEV else BASE_ENDPOINT

ICON_COLOR = 4271458815 if DEV else 431817727  # Orange (#ea580c) for Dev, Emerald (#15803d) for prod
UNSIGNED_PATH = "scratch/handoff_dev_unsigned.shortcut" if DEV else "scratch/handoff_unsigned.shortcut"
SIGNED_PATH = "public/shortcut/handoff-to-pc-dev.shortcut" if DEV else "public/shortcut/handoff-to-pc.shortcut"

SHORTCUT_INPUT = {"Value": {"Type": "ExtensionInput"}, "WFSerializationType": "WFTextTokenAttachment"}


def output_of(uuid, name):
    return {
        "Value": {"Type": "ActionOutput", "OutputUUID": uuid, "OutputName": name},
        "WFSerializationType": "WFTextTokenAttachment",
    }


def if_type_is(group, type_name):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
        "WFWorkflowActionParameters": {
            "GroupingIdentifier": group,
            "WFControlFlowMode": 0,
            "WFCondition": 4,  # "is"
            "WFConditionalActionString": type_name,
            "WFInput": {"Type": "Variable", "Variable": output_of("GET_TYPE", "Type")},
        },
    }


def otherwise(group):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
        "WFWorkflowActionParameters": {"GroupingIdentifier": group, "WFControlFlowMode": 1},
    }


def end_if(group, uuid):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
        "WFWorkflowActionParameters": {"GroupingIdentifier": group, "WFControlFlowMode": 2, "UUID": uuid},
    }


def post_json(uuid, key):
    """POST {"<key>": <Shortcut Input as text>} — a URL becomes its address, not a downloaded page."""
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
        "WFWorkflowActionParameters": {
            "UUID": uuid,
            "WFURL": ENDPOINT,
            "WFHTTPMethod": "POST",
            "WFHTTPBodyType": "JSON",
            "WFJSONValues": {
                "Value": {
                    "WFDictionaryFieldValueItems": [
                        {
                            "WFItemType": 0,  # Text
                            "WFKey": {"Value": {"string": key}, "WFSerializationType": "WFTextTokenString"},
                            "WFValue": {
                                "Value": {
                                    "string": "￼",
                                    "attachmentsByRange": {"{0, 1}": {"Type": "ExtensionInput"}},
                                },
                                "WFSerializationType": "WFTextTokenString",
                            },
                        }
                    ]
                },
                "WFSerializationType": "WFDictionaryFieldValue",
            },
        },
    }


def post_file(uuid):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
        "WFWorkflowActionParameters": {
            "UUID": uuid,
            "WFURL": ENDPOINT,
            "WFHTTPMethod": "POST",
            "WFHTTPBodyType": "File",
            "WFRequestVariable": SHORTCUT_INPUT,
        },
    }


shortcut_data = {
    "WFWorkflowClientVersion": "2607.1",
    "WFWorkflowClientRelease": "3.0",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowTypes": ["ActionExtension"],
    "WFWorkflowInputContentItemClasses": [
        "WFImageContentItem",
        "WFGenericFileContentItem",
        "WFURLContentItem",
        "WFStringContentItem",
        "WFAVAssetContentItem",
    ],
    "WFWorkflowIcon": {
        "WFWorkflowIconGlyphNumber": 59487,  # Screen / Devices glyph
        "WFWorkflowIconStartColor": ICON_COLOR,
    },
    "WFWorkflowActions": [
        # 1. What was shared? (URL / Text / Image / File ...)
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.getitemtype",
            "WFWorkflowActionParameters": {"UUID": "GET_TYPE", "WFInput": SHORTCUT_INPUT},
        },
        # 2. Links -> JSON {"url"}; text -> JSON {"text"}; everything else -> file upload
        if_type_is("IS_URL", "URL"),
        post_json("SEND_LINK", "url"),
        otherwise("IS_URL"),
        if_type_is("IS_TEXT", "Text"),
        post_json("SEND_TEXT", "text"),
        otherwise("IS_TEXT"),
        post_file("UPLOAD_ACTION"),
        end_if("IS_TEXT", "END_IS_TEXT"),
        end_if("IS_URL", "END_IS_URL"),
        # 3. Extract redirectUrl from whichever request ran
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.getvalueforkey",
            "WFWorkflowActionParameters": {
                "UUID": "GET_REDIRECT_URL",
                "WFDictionaryKey": "redirectUrl",
                "WFInput": output_of("END_IS_URL", "If Result"),
            },
        },
        # 4. Open it (claims the room from localStorage or shows the QR code)
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.openurl",
            "WFWorkflowActionParameters": {"WFInput": output_of("GET_REDIRECT_URL", "Dictionary Value")},
        },
    ],
}

os.makedirs("public/shortcut", exist_ok=True)
os.makedirs("scratch", exist_ok=True)

with open(UNSIGNED_PATH, "wb") as f:
    plistlib.dump(shortcut_data, f, fmt=plistlib.FMT_BINARY)

res = subprocess.run(
    ["shortcuts", "sign", "--mode", "anyone", "--input", UNSIGNED_PATH, "--output", SIGNED_PATH],
    capture_output=True,
    text=True,
)

if res.returncode == 0:
    print("SUCCESS: Signed shortcut created at:", SIGNED_PATH)
else:
    print("FAILED with code:", res.returncode)
    print("Stderr:", res.stderr)
    sys.exit(1)
