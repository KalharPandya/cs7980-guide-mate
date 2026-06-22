// md2pdf-continuous: render a markdown file to a single, continuous PDF page
// (no pagination, no page-break gaps) using the solworktech/md2pdf engine,
// with clickable links and a custom (non-bland) theme.
//
// Method (two passes, no cropping):
//  1. Render onto one very tall page with gofpdf auto page break disabled, so
//     all content flows continuously with no inter-page gaps. Measure the final
//     pen position (GetY), which is the exact content height.
//  2. Re-render at page height = content height + bottom margin, so the single
//     page is exactly as tall as the content, content anchored at the top.
//
// Links: parser.Autolink turns bare URLs into links; md2pdf's writeLink emits
// real gofpdf link annotations, so URLs are clickable and styled by the theme.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/gomarkdown/markdown/parser"
	mdtopdf "github.com/solworktech/md2pdf/v2"
)

// extensions mirrors the md2pdf CLI defaults and importantly includes Autolink
// (clickable bare URLs) and Tables.
const extensions = parser.NoIntraEmphasis | parser.Tables | parser.FencedCode |
	parser.Autolink | parser.Strikethrough | parser.SpaceHeadings |
	parser.HeadingIDs | parser.BackslashLineBreak | parser.DefinitionLists

func render(content []byte, outFile string, width, height float64, themeFile string) (float64, error) {
	params := mdtopdf.PdfRendererParams{
		Orientation: "portrait",
		Papersz:     fmt.Sprintf("%gx%g", width, height), // custom WxH (patched md2pdf)
		PdfFile:     outFile,
		TracerFile:  "",
		Theme:       mdtopdf.LIGHT,
	}
	if themeFile != "" {
		params.Theme = mdtopdf.CUSTOM
		params.CustomThemeFile = themeFile
	}
	pf := mdtopdf.NewPdfRenderer(params)
	pf.Extensions = extensions        // enable Autolink (clickable URLs) + Tables
	pf.Pdf.SetAutoPageBreak(false, 0) // single continuous page, no pagination
	if err := pf.Process(content); err != nil {
		return 0, err
	}
	return pf.Pdf.GetY(), nil
}

func main() {
	in := flag.String("i", "", "input markdown file")
	out := flag.String("o", "", "output PDF file")
	width := flag.Float64("w", 595.28, "page width in points (A4 width by default)")
	tall := flag.Float64("tall", 60000, "pass-1 tall page height in points")
	bottom := flag.Float64("bottom", 36, "bottom margin in points")
	themeFile := flag.String("theme-file", "", "path to a custom theme JSON (blank = built-in light)")
	flag.Parse()

	if *in == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: -i input.md -o output.pdf [-w width] [-bottom margin] [-theme-file theme.json]")
		os.Exit(2)
	}

	content, err := os.ReadFile(*in)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read input:", err)
		os.Exit(1)
	}

	// Pass 1: measure content height on a tall page.
	tmp := *out + ".pass1.tmp"
	contentY, err := render(content, tmp, *width, *tall, *themeFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pass1:", err)
		os.Exit(1)
	}
	os.Remove(tmp)
	if contentY <= 0 || contentY >= *tall {
		fmt.Fprintf(os.Stderr, "pass1: implausible content height %.1f (page %.0f); increase -tall\n", contentY, *tall)
		os.Exit(1)
	}

	finalHeight := contentY + *bottom

	// Pass 2: render at the exact content height.
	if _, err := render(content, *out, *width, finalHeight, *themeFile); err != nil {
		fmt.Fprintln(os.Stderr, "pass2:", err)
		os.Exit(1)
	}

	fmt.Printf("OK %s : single continuous page %.2f x %.2f pt (%.2f in tall), content height %.2f pt\n",
		*out, *width, finalHeight, finalHeight/72.0, contentY)
}
