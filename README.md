# Magic Number Converter

A VS Code extension for C and C++ that **finds magic numbers, walks you through them one by one, and lets you decide for each: keep it, or turn it into a named constant.**

New constants are placed where they belong: in the **matching header** (`foo.cpp` → `foo.h`), or, if there is no header, in an **anonymous namespace** at the top of the `.cpp`.

```cpp
// before                                    // after
#include <chrono>                            #include <chrono>
                                             #include "client.h"        // added automatically
void Client::connect() {
    socket.setTimeout(5000);                 void Client::connect() {
    retry(3, 250);                               socket.setTimeout(TIMEOUT);
}                                                retry(MAX_RETRIES, RETRY_DELAY);
                                             }

                                             // client.h
                                             #include <string>
                                             
                                             constexpr int TIMEOUT = 5000;
                                             constexpr int MAX_RETRIES = 3;
                                             constexpr int RETRY_DELAY = 250;
```

---

## Table of contents

- [Features](#features)
- [Installation](#installation)
- [Quick start](#quick-start)
- [The review flow in detail](#the-review-flow-in-detail)
- [Where constants are placed](#where-constants-are-placed)
- [What counts as a magic number](#what-counts-as-a-magic-number)
- [Naming and type inference](#naming-and-type-inference)
- [Commands and keybindings](#commands-and-keybindings)
- [Settings](#settings)
- [How "Keep" decisions are stored](#how-keep-decisions-are-stored)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Project structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Guided review**: the editor jumps to each magic number and a menu lets you convert, keep, skip, go back, or stop.
- **Convert one or all**: replace a single occurrence, or every identical literal in the file with one shared constant.
- **Smart placement**: constants go into the corresponding header, or into an anonymous namespace when the `.cpp` has no header. A missing `#include` is added for you.
- **Sensible suggestions**: the constant name is suggested from the surrounding code (`timeout = 5000` → `TIMEOUT`) and the type is inferred from the literal (`3.5f` → `float`).
- **Collision checks**: names must be valid identifiers and must not already appear in the source or target file.
- **Persistent "Keep"**: numbers you decide to leave alone stop being reported.
- **Live hints and quick fixes**: magic numbers are underlined (information level) and offer *Convert* / *Keep* via `Ctrl+.`.
- **Low noise**: ignores comments, strings, char and raw string literals, preprocessor lines, enums, existing `const`/`constexpr` declarations and user-defined literals like `10ms`.
- **Works with C too**: plain C files get `static const` instead of `constexpr`.
- **Undoable**: all changes are normal VS Code edits, so `Ctrl+Z` works.

## Installation

### From a `.vsix` file

1. Download `magic-number-converter-<version>.vsix` from the [Releases](../../releases) page (or build it yourself, see [Development](#development)).
2. In VS Code open the **Extensions** view, click the `…` menu and choose **Install from VSIX…**.
   Or from a terminal:
   ```bash
   code --install-extension magic-number-converter-0.1.0.vsix
   ```

### From source

```bash
git clone https://github.com/LukasRuee/magic-number-converter.git
cd magic-number-converter
npm install
npm run compile
```

Then open the folder in VS Code and press **F5** to start an Extension Development Host.

**Requirements:** VS Code **1.85** or newer.

## Quick start

1. Open a `.c` or `.cpp` file.
2. Press **`Ctrl+Alt+M`** (`Cmd+Alt+M` on macOS), or right-click in the editor and choose **Magic Numbers: Review and Convert**.
3. For every number, pick an action from the menu.

You can also just hover over an underlined number and use the quick fix (`Ctrl+.`) to convert or keep a single one.

## The review flow in detail

For each magic number the editor selects it and shows a menu with the line of code and your progress (`3/12`):

| Action | What it does |
| --- | --- |
| **Convert to constant…** | Asks for a name (pre-filled with a suggestion), declares the constant, replaces this occurrence. |
| **Convert all N occurrences of `X`…** | Same, but replaces every identical literal in the file with the one constant. Only shown if the literal appears more than once. |
| **Keep as is** | Marks this number as intentional. It will not be reported again (see [how Keep is stored](#how-keep-decisions-are-stored)). |
| **Skip** | Move on without deciding; it shows up again in the next review. |
| **Back** | Return to the number you last skipped. |
| **Stop** (or `Esc`) | End the session. |

When the session ends you get a summary (`5 converted, 2 kept, 1 still open`). If the constants were added to another file (e.g. a header), that file is modified but **not saved**; the summary offers a **Save all** button.

If you cancel the name prompt, you stay on the same number and can pick another action.

## Where constants are placed

The target is decided per file, in this order:

1. **You are in a header** (`.h`, `.hpp`, `.hh`, `.hxx`, `.h++`): the constant goes into that same file.
2. **You are in a source file with a matching header**: the header is searched by base name (`foo.cpp` → `foo.h`, `foo.hpp`, `foo.hh`, `foo.hxx`):
   1. next to the source file first,
   2. then anywhere in the workspace (ignoring `node_modules`, `build`, `out`, `.git`).

   If several headers match you are asked which one to use, and there is also an option *"No header: use an anonymous namespace in this file"*.
   If the `.cpp` does not yet include the header, `#include "relative/path/foo.h"` is added after its last top-level include.
3. **No header found**:
   - C++: the constant goes into an **anonymous namespace** in the `.cpp`. An existing top-level `namespace { … }` is reused if it appears *before* the first use; otherwise a new one is created after the includes.
   - C: a `static const` declaration is placed after the includes.

### Placement inside the file

- After the **last top-level `#include`**. Includes nested in `#if`/`#ifdef` blocks are ignored so a constant never ends up inside a conditional.
- If there are no includes: after `#pragma once`, after the `#ifndef X` / `#define X` include guard, or at the top of the file.
- If a run of `constexpr`/`const` lines already follows that point, new constants are appended to that block, so they stay grouped.
- Line endings (LF/CRLF) of the target file are preserved.

Example of a newly created block in a `.cpp` without a header:

```cpp
#include <vector>

namespace {
constexpr int BUFFER_SIZE = 4096;
} // namespace

int main() { /* … */ }
```

> Constants are declared at file scope in the header. If your header wraps everything in a project namespace or a class, move the constant there afterwards (or open an issue if you'd like a smarter placement).

## What counts as a magic number

Any numeric literal that is not one of the allowed values (default: `0`, `1`, `2`; negative values match by absolute value, so `-1` is allowed too).

Recognised literal forms: decimal, hexadecimal (`0xFF`), binary (`0b1010`), octal (`017`), floating point (`3.14`, `1e-3`, `.5f`), digit separators (`1'000'000`) and the usual suffixes (`u`, `l`, `ul`, `ll`, `ull`, `f`, `z`).

**Never reported:**

| Skipped | Example |
| --- | --- |
| Comments | `// timeout 5000` |
| String, char and raw string literals | `"port 8080"`, `'9'`, `R"(123)"` |
| Preprocessor lines | `#define SIZE 4096`, `#if VERSION > 3` |
| `enum` bodies | `enum E { A = 5 };` |
| Existing constant declarations | `constexpr int X = 42;`, `static const double Y = 2.5;` |
| User-defined literals | `10ms`, `5s`, `2.0_km` |
| Digits that are part of identifiers | `x2`, `vec3` |

## Naming and type inference

### Suggested names

The suggestion is derived from the closest identifier before the literal on the same line (keywords and type names are skipped):

| Code | `UPPER_SNAKE` | `kPascalCase` |
| --- | --- | --- |
| `timeout = 5000` | `TIMEOUT` | `kTimeout` |
| `m_maxRetries >= 3` | `MAX_RETRIES` | `kMaxRetries` |
| `sleep(100)` | `SLEEP` | `kSleep` |
| `return 7;` | `MAGIC_7` | `kMagic7` |

`m_` prefixes and trailing underscores are removed. If there is no usable identifier the fallback is `MAGIC_<literal>`. You can always edit the name in the input box. It is validated as an identifier and checked against names already used in the source and target file.

### Inferred types

| Literal | Type |
| --- | --- |
| `42`, `0xFF` | `int` |
| `42u` | `unsigned int` |
| `0x80000000` | `unsigned int` |
| `3000000000` | `long long` |
| `10L` / `10UL` | `long` / `unsigned long` |
| `10LL` / `10ULL` | `long long` / `unsigned long long` |
| `3.14` | `double` |
| `3.14f` | `float` |
| `3.14L` | `long double` |
| `5z` / `5uz` | `std::ptrdiff_t` / `std::size_t` |

The literal is copied into the declaration exactly as written (`1'000'000L` stays `1'000'000L`). If the type is not what you want, adjust the declaration afterwards.

## Commands and keybindings

| Command | Default key | Description |
| --- | --- | --- |
| `Magic Numbers: Review and Convert` | `Ctrl+Alt+M` / `Cmd+Alt+M` | Start the guided review for the active file. Also in the editor context menu. |
| `Magic Numbers: Clear "Keep" Decisions` | – | Forget every number you marked as *Keep* in this workspace. |

Two internal commands (`magicNumbers.convertAt`, `magicNumbers.keepAt`) power the quick fixes and are hidden from the Command Palette.

Supported languages: `c`, `cpp`, `cuda-cpp`, `objective-c`, `objective-cpp`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `magicNumbers.allowedNumbers` | `[0, 1, 2]` | Numbers that are never reported. Compared by absolute value. |
| `magicNumbers.namingStyle` | `"UPPER_SNAKE"` | Style for suggested names: `UPPER_SNAKE` or `kPascalCase`. |
| `magicNumbers.showDiagnostics` | `true` | Underline magic numbers and offer quick fixes. Does not affect the review command. |

Example `settings.json`:

```json
{
  "magicNumbers.allowedNumbers": [0, 1, 2, 10, 100],
  "magicNumbers.namingStyle": "kPascalCase"
}
```

## How "Keep" decisions are stored

"Keep" decisions are saved in VS Code's **workspace state** (per workspace, not in your repository, so nothing is written to your project).

Each decision is identified by *file path + text of the line + literal + which occurrence on that line*, not by line number. That means:

- Adding or removing code above a number does **not** bring it back.
- Editing the line itself (or renaming the file) makes it show up again, which is usually what you want, since the code around it changed.

Use **Magic Numbers: Clear "Keep" Decisions** to reset everything.

## Known limitations

- Detection is **lexical, not semantic**. The extension does not parse C++, so it cannot tell, for example, a template argument from an array size, or know that a number is already self-explanatory in context. Use *Keep* for those.
- Constants in headers are inserted at **file scope**, not inside a namespace or class declared in that header.
- Macros: numbers inside `#define` bodies are intentionally skipped; numbers passed as macro arguments are reported.
- A `const` declaration containing an initializer expression on the same line (`const int x = a ? 3 : 4;`) is skipped entirely.
- The header lookup is based on file names only (`foo.cpp` ↔ `foo.h`); other project layouts are not inferred.
- Edits to files other than the active one are left unsaved on purpose, so review them before saving.

## Development

```bash
npm install          # install dev dependencies
npm run compile      # build once  (TypeScript → out/)
npm run watch        # rebuild on change
```

- Press **F5** in VS Code to launch an Extension Development Host (a `launch.json` is included).
- Create an installable package:
  ```bash
  npx @vscode/vsce package
  ```
  Before publishing, set `publisher` and add a `repository` field in `package.json`:
  ```json
  "publisher": "your-publisher-id",
  "repository": { "type": "git", "url": "https://github.com/LukasRuee/magic-number-converter.git" }
  ```

### Project structure

```
src/
├── extension.ts   # activation, commands, review loop, diagnostics, quick fixes, edits
├── scanner.ts     # source masking (comments/strings/preprocessor) and magic number detection
└── constants.ts   # header lookup, constant placement, naming and type inference
package.json       # manifest: commands, keybindings, settings
```

### How it works

1. `maskSource` returns a copy of the file where comments, string/char/raw-string literals and preprocessor lines are blanked out (same length, same line breaks, so offsets stay valid).
2. A numeric-literal regex runs on the masked text. Candidates are filtered (allowed values, enums, `const` declarations, user-defined literals).
3. The review loop re-scans the document after every action, so edits never leave stale positions behind.
4. A conversion is one `WorkspaceEdit` containing the declaration insertion, the literal replacements and, if needed, the `#include`.

## Contributing

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
