# PagePocket

A Chrome extension that captures any full web page and saves it as a PDF, PNG, or JPEG in one click.

## Features

- **Three output formats** - PDF, PNG, or JPEG
- **Two capture methods:**
  - **Scroll & stitch** - scrolls the page and stitches screenshots together (default, works on most sites)
  - **DOM render** - uses html2canvas to render the full page DOM directly (better for complex layouts)
- **Three quality settings** - Low, Medium, High (affects file size for JPEG and PDF)
- **Live progress bar** - shows capture and save progress step by step
- **Auto-named files** - saved as `page-title_YYYY-MM-DD.pdf` (or `.png` / `.jpg`)
- **Multi-page PDF** - long pages are split across A4 pages automatically

## Installation (Developer Mode)

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked**
5. Select the `pagepocket` folder

## How It Works

### Scroll & stitch (default)
1. Measures the full page height and viewport size
2. Scrolls through the page in viewport-sized steps
3. Takes a screenshot at each position using the Chrome `captureVisibleTab` API
4. Stitches all screenshots onto a single canvas
5. Exports the canvas to the chosen format

### DOM render
1. Injects html2canvas into the page
2. Renders the full page DOM to a canvas in one pass
3. Exports the canvas to the chosen format

## When to use which method

| Method | Best for |
|---|---|
| Scroll & stitch | Most sites - accurate colours, handles images and media |
| DOM render | Sites where scroll & stitch produces gaps or misalignment |

## Permissions

| Permission | Reason |
|---|---|
| `activeTab` | Access the current tab to capture it |
| `scripting` | Inject capture libraries into the page |
| `downloads` | Save the output file to your downloads folder |
| `tabs` | Read tab info and capture visible tab screenshots |
| `host_permissions: <all_urls>` | Required to inject scripts and capture on any site |

## Third-Party Libraries

| Library | Version | Licence |
|---|---|---|
| [html2canvas](https://html2canvas.hertzen.com) | 1.4.1 | MIT |
| [jsPDF](https://github.com/parallax/jsPDF) | 2.5.1 | MIT |

Both libraries are bundled locally and run entirely within your browser. No data is sent anywhere.

## File Structure

```
pagepocket/
  manifest.json         Extension config and permissions
  popup.html            Extension popup UI and styles
  popup.js              Capture logic - scroll/stitch, DOM render, PDF export
  lib/
    html2canvas.min.js  DOM-to-canvas rendering library (MIT)
    jspdf.umd.min.js    PDF generation library (MIT)
  icons/                Extension icons (16px, 48px, 128px)
```

## Licence

MIT (extension code only - bundled libraries retain their own MIT licences)
