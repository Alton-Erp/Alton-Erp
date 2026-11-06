// Product image links: URL rules, Excel import (match by EAN / SKU, fields to modify, blank, invalid), export and re-import (no database).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { EXPORT_COLUMNS, productExportRows } from '../../src/features/products/product-export.ts'
import {
  IMAGE_STATUS_LABELS,
  autoMapColumns,
  identityMaps,
  matchValue,
  modifiableFields,
  productRowToFormValues,
  rowKind,
  summarizeImages,
  validateImportRows,
  type ExistingProduct,
  type ImportContext,
  type ImportFieldKey,
  type MatchKey,
} from '../../src/features/products/product-import.ts'
import { imageUrlProblem, normaliseImageUrl, skuKey } from '../../src/features/products/product-model.ts'
import { EMPTY_PRODUCT_FORM, validateProduct } from '../../src/features/products/product-validation.ts'

const AMAZON = 'https://m.media-amazon.com/images/I/61RypVKnRrL.jpg'
const OTHER = 'https://cdn.example.com/basins/wb-001.webp'

const row = (over: Record<string, unknown> = {}) => ({
  sku: 'WB-001', product_name: 'Ceramic Wash Basin', description: null, category_id: null, brand: 'Alton', model_number: null, barcode: null,
  ean: '8901234567890', image_url: null, status: 'ACTIVE', product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: 'PCS',
  track_batches: false, track_expiry: false, hsn_code: '6910', gst_rate: 18, selling_price: 1300, standard_cost: 800, minimum_selling_price: null,
  reorder_level: null, standard_manufacturing_cost: 1200, mrp: 1500, is_manufacturable: true, has_bom: false, production_notes: null, remarks: null,
  ...over,
})
const stored = (id: string, over: Record<string, unknown> = {}, imagePath: string | null = null): ExistingProduct => {
  const r = row(over)
  return { id, sku: r.sku as string, updatedAt: '2026-11-01T10:00:00Z', imagePath, values: productRowToFormValues(r as Parameters<typeof productRowToFormValues>[0]) }
}
const ctxFor = (products: ExistingProduct[], opts: { fields?: ImportFieldKey[]; matchKey?: MatchKey } = {}): ImportContext => {
  const maps = identityMaps(products.map((p) => ({ id: p.id, sku: p.sku, product_name: p.values.product_name, ean: p.values.ean })))
  const matchKey = opts.matchKey ?? 'SKU'
  const matchIndex = new Map<string, ExistingProduct[]>()
  if (matchKey === 'EAN') for (const p of products) matchIndex.set(matchValue('EAN', p.values.ean), [p])
  return {
    categories: [], existingSkus: maps.existingSkus, existingBarcodes: new Set(), duplicateMode: 'update',
    existingProducts: new Map(products.map((p) => [skuKey(p.sku), p])), existingNames: maps.existingNames, looseSkus: maps.looseSkus,
    modifyFields: opts.fields ? new Set(opts.fields) : undefined, matchKey, matchIndex: matchKey === 'EAN' ? matchIndex : undefined,
    skuOwners: maps.skuIds,
  }
}

describe('image link rules (same as the database)', () => {
  it('accepts http and https image links, including Amazon links', () => {
    for (const u of [AMAZON, OTHER, 'http://images.example.in/a.png?w=400#x', 'https://example.com:8443/img']) assert.equal(imageUrlProblem(u), null, u)
    assert.equal(imageUrlProblem(''), null, 'blank is allowed (no image)')
    assert.equal(normaliseImageUrl(`  ${AMAZON}  `), AMAZON)
    assert.equal(normaliseImageUrl('   '), null)
  })

  it('rejects other protocols, malformed values, user names, local and private addresses, and over-long links', () => {
    const bad: [string, RegExp][] = [
      ['ftp://example.com/a.jpg', /http:\/\/ or https:\/\//], ['javascript:alert(1)', /http:\/\/ or https:\/\//], ['data:image/png;base64,AAAA', /http/],
      ['file:///etc/passwd', /http/], ['www.example.com/a.jpg', /http/], ['https://exa mple.com/a.jpg', /spaces/], ['https://', /not a valid/],
      ['https://user:pass@example.com/a.jpg', /user name or password/], ['http://localhost/a.jpg', /private network/], ['http://127.0.0.1/a.jpg', /private network/],
      ['http://192.168.1.10/a.jpg', /private network/], ['http://10.0.0.5/a.jpg', /private network/], ['http://172.20.1.1/a.jpg', /private network/],
      ['http://169.254.169.254/latest/meta-data', /private network/], ['http://printer.local/a.jpg', /private network/], [`https://example.com/${'a'.repeat(2050)}`, /too long/],
    ]
    for (const [u, re] of bad) assert.match(imageUrlProblem(u) ?? 'accepted', re, u)
  })

  it('the product form reports an invalid link beside the field', () => {
    const base = { ...EMPTY_PRODUCT_FORM, product_name: 'Basin', product_type: 'FINISHED_GOOD' as const }
    assert.match(validateProduct({ ...base, image_url: 'ftp://x.com/a.jpg' }).errors.image_url!, /http/)
    assert.equal(validateProduct({ ...base, image_url: ` ${AMAZON} ` }).input?.image_url, AMAZON)
    assert.equal(validateProduct(base).input?.image_url, null)
  })
})

describe('Excel import: Image Link column', () => {
  it('is detected from the usual headers and can be modified, but is never a match key', () => {
    for (const h of ['Image Link', 'Image URL', 'Product Image', 'Product Image URL', 'Image', 'Photo URL', 'Picture URL', 'image url']) {
      assert.equal(autoMapColumns(['SKU', h]).image_url, 1, h)
    }
    const mapping = autoMapColumns(['EAN Code', 'Image Link'])
    assert.equal(mapping.ean, 0)
    assert.deepEqual(modifiableFields(mapping, 'EAN').map((f) => f.key), ['image_url'])
  })

  it('1. an existing product matched by EAN gets the image; nothing else changes and no product is added', () => {
    const products = [stored('p1')]
    const [r] = validateImportRows([['8901234567890', AMAZON]], autoMapColumns(['EAN Code', 'Image Link']), ctxFor(products, { matchKey: 'EAN', fields: ['image_url'] }))
    assert.equal(rowKind(r), 'modified')
    assert.equal(r.productId, 'p1')
    assert.deepEqual(r.input, { image_url: AMAZON }, 'only the image link is sent: SKU, EAN, prices and costs are untouched')
    assert.equal(r.image?.status, 'new')
    assert.equal(IMAGE_STATUS_LABELS[r.image!.status], 'New Image')
  })

  it('2. matched by SKU; 5. an existing image is updated', () => {
    const products = [stored('p1', { image_url: OTHER })]
    const [r] = validateImportRows([['WB-001', AMAZON]], autoMapColumns(['SKU', 'Image URL']), ctxFor(products, { fields: ['image_url'] }))
    assert.deepEqual(r.input, { image_url: AMAZON })
    assert.equal(r.image?.status, 'changed')
    assert.equal(r.compared?.find((c) => c.field === 'image_url')?.action, 'update')
  })

  it('3. several products in one file; 4. a new product gets its image', () => {
    const products = [stored('p1'), stored('p2', { sku: 'WB-002', product_name: 'Basin 2', ean: '4006381333931' })]
    const rows = [['WB-001', 'Basin', 'Finished Good', AMAZON], ['WB-002', 'Basin 2', 'Finished Good', OTHER], ['WB-003', 'New basin', 'Finished Good', AMAZON]]
    const r = validateImportRows(rows, autoMapColumns(['SKU', 'Product Name', 'Product Type', 'Image Link']), ctxFor(products, { fields: ['image_url'] }))
    assert.deepEqual(r.map(rowKind), ['modified', 'modified', 'new'])
    assert.equal(r[2].input?.image_url, AMAZON)
    assert.deepEqual(summarizeImages(r), { mapped: true, add: 3, update: 0, unchanged: 0, invalid: 0, blank: 0, notSelected: 0 })
  })

  it('6. Image Link not selected: the stored image is kept', () => {
    const products = [stored('p1', { image_url: OTHER })]
    const [r] = validateImportRows([['WB-001', AMAZON, '999']], autoMapColumns(['SKU', 'Image Link', 'MRP']), ctxFor(products, { fields: ['mrp'] }))
    assert.deepEqual(r.input, { mrp: 999 })
    assert.equal(r.image?.status, 'not-selected')
    assert.equal(r.image?.selected, false)
  })

  it('7. a blank cell never removes an image; the same link is unchanged', () => {
    const products = [stored('p1', { image_url: OTHER }), stored('p2', { sku: 'WB-002', product_name: 'Basin 2', image_url: AMAZON })]
    const [blank, same] = validateImportRows([['WB-001', ''], ['WB-002', ` ${AMAZON} `]], autoMapColumns(['SKU', 'Image Link']), ctxFor(products, { fields: ['image_url'] }))
    assert.equal(blank.status, 'skipped')
    assert.equal(blank.image?.status, 'blank')
    assert.equal(blank.compared?.find((c) => c.field === 'image_url')?.action, 'blank')
    assert.equal(same.status, 'skipped')
    assert.equal(same.image?.status, 'unchanged')
    const s = summarizeImages([blank, same])
    assert.equal(s.blank, 1)
    assert.equal(s.unchanged, 1)
  })

  it('8. an invalid link is reported and not saved; the rest of the row is still imported', () => {
    const products = [stored('p1')]
    const [r] = validateImportRows([['WB-001', 'javascript:alert(1)', '1600']], autoMapColumns(['SKU', 'Image Link', 'MRP']), ctxFor(products, { fields: ['image_url', 'mrp'] }))
    assert.equal(r.status, 'valid')
    assert.deepEqual(r.input, { mrp: 1600 })
    assert.equal(r.image?.status, 'invalid')
    assert.match(r.warnings.join(' '), /Image Link not imported/)
    const [n] = validateImportRows([['WB-009', 'New', 'Finished Good', 'ftp://x/a.jpg']], autoMapColumns(['SKU', 'Product Name', 'Product Type', 'Image Link']), ctxFor([]))
    assert.equal(rowKind(n), 'new')
    assert.equal(n.input?.image_url, null, 'a new product is added without the invalid link')
    assert.equal(summarizeImages([r, n]).invalid, 2)
  })

  it('an uploaded image stays shown: the preview says so', () => {
    const [r] = validateImportRows([['WB-001', AMAZON]], autoMapColumns(['SKU', 'Image Link']), ctxFor([stored('p1', {}, 'c/p1/x.jpg')], { fields: ['image_url'] }))
    assert.equal(r.image?.uploaded, true)
    assert.match(r.warnings.join(' '), /uploaded image/)
  })
})

describe('13–14. export and re-import', () => {
  it('exports the saved link, which imports back unchanged without duplicate products', () => {
    const product = { ...row({ image_url: AMAZON }), id: 'p1', archived_at: null, lead_time_days: null, reorder_level_days: null, minimum_cover_days: null,
      group_head: null, supplier_model_number: null, supplier_product_name: null, length_cm: null, width_cm: null, height_cm: null, preferred_supplier_id: null }
    const [header, cells] = productExportRows([product as never], [])
    assert.ok(EXPORT_COLUMNS.includes('Image Link'))
    assert.equal(cells[header.indexOf('Image Link')], AMAZON)
    const mapping = autoMapColumns(header.map(String))
    assert.equal(mapping.image_url, header.indexOf('Image Link'))
    const [r] = validateImportRows([cells.map((c) => (c === null || c === undefined ? '' : String(c)))], mapping, ctxFor([stored('p1', { image_url: AMAZON })]))
    assert.equal(rowKind(r), 'skipped', 'the exported product matches the stored one: no update, no new product')
    assert.equal(r.image?.status, 'unchanged')
  })
})
