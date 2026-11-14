# Third-party notices

Termnest includes the components below. Their licenses apply independently of Termnest’s MIT license. Copyright statements below are transcribed from the installed LICENSE files; upstream attribution emails are retained. Full license texts are linked and copied into the desktop payload’s `licenses/` directory. Original dependency LICENSE files and bundled font licenses also remain in the payload.

## Production npm dependencies

This inventory covers every production-lockfile entry, including optional and build support packages. Assembly excludes `nan`, `node-addon-api` and `cpu-features` after installation; their notices are retained here for source distributions and completeness.

| Package | Version | License | Copyright from LICENSE | Full text |
|---|---|---|---|---|
| @xterm/addon-fit | 0.10.0 | MIT | Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js) | [LICENSE](docs/licenses/xterm-addon-fit.txt) |
| @xterm/xterm | 5.5.0 | MIT | Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js); Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com); Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/) | [LICENSE](docs/licenses/xterm-xterm.txt) |
| argparse | 2.0.1 | Python-2.0 | Copyright (c) 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020 Python Software Foundation; All Rights Reserved; Copyright (c) 1995-2001 Corporation for National Research Initiatives; All Rights Reserved; Copyright (c) 1991 - 1995, Stichting Mathematisch Centrum Amsterdam, The Netherlands. All rights reserved. | [LICENSE](docs/licenses/argparse.txt) |
| asn1 | 0.2.6 | MIT | Copyright (c) 2011 Mark Cavage, All rights reserved. | [LICENSE](docs/licenses/asn1.txt) |
| bcrypt-pbkdf | 1.0.2 | BSD-3-Clause AND ISC (see full text) | Copyright 1997 Niels Provos &lt;provos@physnet.uni-hamburg.de&gt;; Copyright (c) 2013 Ted Unangst &lt;tedu@openbsd.org&gt;; Copyright 2016, Joyent Inc | [LICENSE](docs/licenses/bcrypt-pbkdf.txt) |
| buildcheck | 0.0.7 | MIT | Copyright Brian White. All rights reserved. | [LICENSE](docs/licenses/buildcheck.txt) |
| cpu-features | 0.0.10 | MIT | Copyright Brian White. All rights reserved. | [LICENSE](docs/licenses/cpu-features.txt) |
| entities | 4.5.0 | BSD-2-Clause | Copyright (c) Felix Böhm | [LICENSE](docs/licenses/entities.txt) |
| linkify-it | 5.0.2 | MIT | Copyright (c) 2015 Vitaly Puzrin. | [LICENSE](docs/licenses/linkify-it.txt) |
| markdown-it | 14.3.3 | MIT | Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin. | [LICENSE](docs/licenses/markdown-it.txt) |
| mdurl | 2.1.0 | MIT | Copyright (c) 2015 Vitaly Puzrin, Alex Kocharin.; Copyright Joyent, Inc. and other Node contributors. All rights reserved. | [LICENSE](docs/licenses/mdurl.txt) |
| nan | 2.30.0 | MIT | Copyright (c) 2018 [NAN contributors](https://github.com/nodejs/nan#wg-members--collaborators) | [LICENSE](docs/licenses/nan.txt) |
| node-addon-api | 7.1.1 | MIT | Copyright (c) 2017 [Node.js API collaborators](https://github.com/nodejs/node-addon-api#collaborators) | [LICENSE](docs/licenses/node-addon-api.txt) |
| node-pty | 1.1.0 | MIT | Copyright (c) 2012-2015, Christopher Jeffrey (https://github.com/chjj/); Copyright (c) 2016, Daniel Imms (http://www.growingwiththeweb.com); Copyright (c) 2018 - present Microsoft Corporation | [LICENSE](docs/licenses/node-pty.txt) |
| punycode.js | 2.3.1 | MIT | Copyright Mathias Bynens &lt;https://mathiasbynens.be/&gt; | [LICENSE](docs/licenses/punycode.js.txt) |
| safer-buffer | 2.1.2 | MIT | Copyright (c) 2018 Nikita Skovoroda &lt;chalkerx@gmail.com&gt; | [LICENSE](docs/licenses/safer-buffer.txt) |
| ssh2 | 1.16.0 | MIT | Copyright Brian White. All rights reserved. | [LICENSE](docs/licenses/ssh2.txt) |
| tweetnacl | 0.14.5 | Unlicense | Public domain dedication; no copyright holder line in LICENSE (Unlicense). | [LICENSE](docs/licenses/tweetnacl.txt) |
| uc.micro | 2.1.0 | MIT | Copyright Mathias Bynens &lt;https://mathiasbynens.be/&gt; | [LICENSE](docs/licenses/uc.micro.txt) |
| ws | 8.23.0 | MIT | Copyright (c) 2011 Einar Otto Stangvik &lt;einaros@gmail.com&gt;; Copyright (c) 2013 Arnout Kazemier and contributors; Copyright (c) 2016 Luigi Pinca and contributors | [LICENSE](docs/licenses/ws.txt) |

## Native terminal components

- **winpty** — MIT. Copyright (c) 2011-2016 Ryan Prichard [Full text](docs/licenses/winpty.txt).
- **Google cpu_features** — Apache-2.0 (optional build support; pruned from runtime). Copyright (C) 2010 The Android Open Source Project [Full text](docs/licenses/Google-cpu_features.txt).

## Bundled fonts

- **Be Vietnam Pro** — SIL Open Font License 1.1 (OFL-1.1). Copyright 2021 The Be Vietnam Pro Project Authors (https://github.com/bettergui/BeVietnamPro). [Full text](docs/licenses/be-vietnam-pro.txt).
- **JetBrains Mono** — SIL Open Font License 1.1 (OFL-1.1). Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono). [Full text](docs/licenses/jetbrains-mono.txt).
- **Nunito** — SIL Open Font License 1.1 (OFL-1.1). Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito). [Full text](docs/licenses/nunito.txt).
- **Lilita One** — SIL Open Font License 1.1, Copyright 2011 Juan Montoreano, glyph outlines used in the logo artwork. [Full text](docs/licenses/lilita-one.txt).

## Node.js runtime

**Node.js 22.14.0** — MIT for Node.js itself. “Copyright Node.js contributors. All rights reserved.” Legacy portions: “Copyright Joyent, Inc. and other Node contributors. All rights reserved.” The runtime embeds third-party components under additional licenses (including MIT, BSD, Apache-2.0 and Unicode terms); preserve the [complete runtime LICENSE](docs/licenses/Node.js-22.14.0.txt), which includes their notices. Runtime preparation also retains the LICENSE from each downloaded archive.

## Tauri and native Rust shell

The following direct runtime crates are dual licensed **MIT OR Apache-2.0**, as declared by their pinned Cargo manifests:

| Crate | Version |
|---|---|
| tauri | 2.12.5 |
| tauri-plugin-dialog | 2.8.4 |
| tauri-plugin-single-instance | 2.5.5 |
| tauri-plugin-window-state | 2.5.0 |
| tauri-plugin-opener | 2.7.2 |
| tauri-plugin-notification | 2.8.0 |
| tauri-plugin-clipboard-manager | 2.5.0 |
| serde_json | 1.0.154 |

Copyright (c) 2017 - Present Tauri Apps Contributors. [MIT text](docs/licenses/Tauri-LICENSE-MIT.txt), [Apache-2.0 text](docs/licenses/Tauri-LICENSE-APACHE-2.0.txt). Plugin namespaces and licenses remain unchanged. The exact Rust dependency graph, including platform-specific and build-time crates, is recorded in `desktop/Cargo.lock`; the summary above is for the direct shipped shell dependencies. `tauri-build` 2.7.4 is build-time only (MIT OR Apache-2.0).

## External software

tmux, SSH servers, WSL, Claude Code, Codex CLI and system WebViews are external tools or operating-system components, not bundled npm dependencies. Their names and marks belong to their respective owners.
