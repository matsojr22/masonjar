# Mason Jar

![Licence](https://img.shields.io/github/license/Ileriayo/markdown-badges?style=for-the-badge) ![Electron.js](https://img.shields.io/badge/Electron-191970?style=for-the-badge&logo=Electron&logoColor=white) ![Windows](https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white) ![Mac OS](https://img.shields.io/badge/mac%20os-000000?style=for-the-badge&logo=macos&logoColor=F0F0F0) ![Linux](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)

# Introduction

Mason Jar is a fork of [Bell Jar](https://github.com/asoronow/belljar) for neurohistology analysis of the mouse brain. It supports new `.masonjar` project bundles while remaining compatible with legacy `.belljar` projects and `~/.belljar` user data.

# Compatibility

Mason Jar aims to run on any platform; release binaries are provided where tested. If you do not see your OS, build from source using the instructions below.

Legacy Bell Jar projects (`*.belljar`, `project.belljar`, `~/.belljar`) open without conversion. New projects use `*.masonjar`, `project.masonjar`, and `~/.masonjar` by default.

# Usage

See `docs/belljar_guide.pdf` in the repository for workflow instructions and a guide to each tool. The guide retains upstream Bell Jar branding; Mason Jar behavior is the same unless noted in release notes.

# Requirements

- At least 20GB of disk space
- 32GB of memory MINIMUM (64GB recommended)
- Intel i5 / Apple Silicon / AMD Ryzen 4th gen
- (REQUIRED) GPU with at least 6 GB of VRAM and CUDA 11 support

# Install from Release

Download the most recent release for your OS from [matsojr22/masonjar releases](https://github.com/matsojr22/masonjar/releases).

Extract the archive and run the Mason Jar executable (`Mason Jar.app` on macOS, `Mason Jar.exe` on Windows).

Note: On some macOS systems you may need to authorize the app to run since code signing is not implemented. See [Apple's guide on running unsigned code](https://support.apple.com/en-us/HT202491).

# Install from Source

Clone this repository and run:

```
git clone https://github.com/matsojr22/masonjar.git
cd masonjar
npm install -g yarn   # if needed
yarn install
yarn compile
yarn start
```

First launch downloads ~20GB of models and embeddings from the upstream Bell Jar CDN (`storage.googleapis.com/belljar_updates`).

# How to work with annotations

Annotations can be loaded with Python's pickle library and numpy. Each pixel is an Allen Atlas region id. Region metadata is in `structure_graph.json` in the csv folder.

Note: Mason Jar uses the `id` field, not `atlas_id`.

```
import pickle
import numpy as np

with open("Annotation_MyBrain_s001.pkl", "rb") as file:
    annotation = pickle.load(file)
```

# Attribution

Mason Jar is maintained by [matsojr22](https://github.com/matsojr22). It is derived from Bell Jar by Alec Soronow and the Euiseok Kim Lab, used under the MIT License. See `pages/credits.html` for full attribution.
