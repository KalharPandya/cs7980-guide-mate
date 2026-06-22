# md2pdf-continuous

Render a markdown file to a **single continuous PDF page**: one page, no
pagination, and no page-break gaps. The rendering engine is
[solworktech/md2pdf](https://github.com/solworktech/md2pdf); this folder adds the
small piece md2pdf does not ship: a custom page height so the whole document
flows onto one page.

## Why a patch is needed

md2pdf is built on gofpdf and paginates by default. Its CLI only accepts named
page sizes (A3, A4, A5), and its library constructor only takes named sizes too.
A true continuous page needs two things gofpdf supports but md2pdf does not
expose: a custom (very tall) page size, and auto page break turned off.

`md2pdf-customsize.patch` adds one capability to md2pdf: a `WxH` paper size
string (for example `595.28x60000`) that maps to `fpdf.NewCustom`. Everything
else (fonts, themes, tables, syntax highlighting) is unchanged upstream md2pdf.

## How it works

`main.go` is a small wrapper that uses patched md2pdf as a library and renders
in two passes:

1. Render onto one very tall page with `SetAutoPageBreak(false, 0)`, so all
   content flows continuously with no inter-page gaps. Read the final pen
   position (`GetY`), which is the exact content height.
2. Re-render at page height = content height + bottom margin, so the single page
   is exactly as tall as the content, with the content anchored at the top and
   no blank tail.

The result is a correct MediaBox (every viewer shows the right size) with no
cropping tricks.

## Usage

```bash
# requires go (1.24+) and git; first run fetches md2pdf at the pinned commit
./render.sh path/to/input.md path/to/output.pdf
# optional: page width in points (default 595.28 = A4 width) and bottom margin
./render.sh input.md output.pdf 595.28 36
```

`UPSTREAM_COMMIT` pins the exact md2pdf commit the patch targets, so the build is
reproducible across laptops. The fetched source and Go build are cached under
`~/.cache/md2pdf-continuous` (override with `MD2PDF_CACHE`).

## Notes

- A long document becomes a very tall page. The example research draft (about
  5,250 words) renders as roughly 114 inches tall, which is within the common
  200-inch viewer limit. Extremely long inputs may exceed that limit; widen the
  page (`width` argument) to reduce height if needed.
- Verify output with `pdfinfo file.pdf` (expect `Pages: 1`) or PyMuPDF.
