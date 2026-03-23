import { NextResponse } from "next/server";
import { runProductMatcherFromBuffer } from "../../../../../productMatcher";

/**
 * POST /api/products/upload
 *
 * Accepts a multipart form upload containing an .xlsx product file.
 * Parses it, matches every product to events in S3 (fashion_keywords scoring),
 * merges matched style_codes into event.products, and re-uploads updated day files.
 *
 * Form field: "file"  (the .xlsx Excel file)
 * Optional query param: ?dry_run=true  (score only, no writes)
 *
 * Response:
 * {
 *   "success": true,
 *   "products_in_file": 120,
 *   "events_in_s3": 47,
 *   "new_links_added": 210,
 *   "events_with_new_products": 34,
 *   "matches": { "<event_id>": ["SC001", ...] }
 * }
 */
export async function POST(request) {
  try {
    // ── 1. Parse form data
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file) {
      return NextResponse.json(
        { success: false, error: "No file uploaded. Send the .xlsx as field 'file'." },
        { status: 400 }
      );
    }

    const fileName = file.name || "upload.xlsx";
    const ext = fileName.split(".").pop().toLowerCase();
    if (!["xlsx", "xls"].includes(ext)) {
      return NextResponse.json(
        { success: false, error: `Unsupported file type: .${ext}. Send an .xlsx file.` },
        { status: 400 }
      );
    }

    // ── 2. Read dry_run flag from query params
    const { searchParams } = new URL(request.url);
    const dryRun = searchParams.get("dry_run") === "true";

    // ── 3. Convert file to buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    console.log(`\n📤 /api/products/upload — ${fileName} (${buffer.length} bytes)${dryRun ? " [DRY RUN]" : ""}`);

    // ── 4. Run the matching pipeline
    const summary = await runProductMatcherFromBuffer(buffer, fileName, dryRun);

    // ── 5. Return result
    return NextResponse.json({
      success: true,
      dry_run: dryRun,
      products_in_file:           summary.products_in_file,
      events_in_s3:               summary.events_in_s3,
      new_links_added:            summary.new_links_added,
      events_with_new_products:   summary.events_with_new_products,
      matches:                    summary.matches,
    });

  } catch (err) {
    console.error("❌ /api/products/upload error:", err.message);
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}

// Only POST is supported on this route
export async function GET() {
  return NextResponse.json(
    { error: "Method not allowed. Use POST with an .xlsx file." },
    { status: 405 }
  );
}
