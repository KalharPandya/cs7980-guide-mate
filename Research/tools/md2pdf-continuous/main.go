// md2pdf-continuous: render a markdown file to a single, continuous PDF page
// (no pagination, no page-break gaps) using the solworktech/md2pdf engine.
//
// Method (two passes, no cropping):
//  1. Render onto one very tall page with gofpdf auto page break disabled, so
//     all content flows continuously with no inter-page gaps. Measure the final
//     pen position (GetY), which is the exact content height.
//  2. Re-render at page height = content height + bottom margin, so the single
//     page is exactly as tall as the content. MediaBox is correct everywhere
//     and the content is anchored at the top with no blank tail.
package main

import (
	"flag"
	"fmt"
	"os"

	mdtopdf "github.com/solworktech/md2pdf/v2"
)

func render(content []byte, outFile string, width, height float64, th mdtopdf.Theme) (float64, error) {
	params := mdtopdf.PdfRendererParams{
		Orientation: "portrait",
		Papersz:     fmt.Sprintf("%gx%g", width, height), // custom WxH (patched md2pdf)
		PdfFile:     outFile,
		TracerFile:  "",
		Theme:       th,
	}
	pf := mdtopdf.NewPdfRenderer(params)
	// The whole point: one continuous page, no pagination, no page-break gaps.
	pf.Pdf.SetAutoPageBreak(false, 0)
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
	theme := flag.String("theme", "light", "light|dark")
	flag.Parse()

	if *in == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: -i input.md -o output.pdf [-w width] [-tall height] [-bottom margin]")
		os.Exit(2)
	}

	content, err := os.ReadFile(*in)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read input:", err)
		os.Exit(1)
	}

	th := mdtopdf.LIGHT
	if *theme == "dark" {
		th = mdtopdf.DARK
	}

	// Pass 1: measure content height on a tall page.
	tmp := *out + ".pass1.tmp"
	contentY, err := render(content, tmp, *width, *tall, th)
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
	if _, err := render(content, *out, *width, finalHeight, th); err != nil {
		fmt.Fprintln(os.Stderr, "pass2:", err)
		os.Exit(1)
	}

	fmt.Printf("OK %s : single continuous page %.2f x %.2f pt (%.2f in tall), content height %.2f pt\n",
		*out, *width, finalHeight, finalHeight/72.0, contentY)
}
