#!/usr/bin/env python3
"""Builds the Dev shortcut (tunnel.handoffdrop.app). Same as: python3 scripts/generate-shortcut.py --dev"""
import os
import subprocess
import sys

script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "generate-shortcut.py")
sys.exit(subprocess.call([sys.executable, script, "--dev"]))
