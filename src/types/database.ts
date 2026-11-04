/**
 * Database types for the Supabase client.
 *
 * Hand-written to match supabase/migrations (Phase 2) in the same shape that
 * `supabase gen types typescript` produces. Once a project is linked, replace
 * this file with generated output:
 *
 *   npx supabase gen types typescript --project-id <ref> --schema public > src/types/database.ts
 */

import type { InventoryFunctions, InventoryTables, InventoryViews } from './database-inventory'
import type { ProductionTables, ProductionViews } from './database-production'
import type { CustomerPoTables, CustomerPoViews } from './database-customer-po'
import type { SalesTables, SalesViews } from './database-sales'
import type { BillingTables, BillingViews } from './database-billing'
import type { SupplierFunctions, SupplierTables } from './database-suppliers'
import type { PurchasingTables, PurchasingViews } from './database-purchasing'

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      companies: {
        Row: {
          id: string
          legal_name: string
          display_name: string
          company_code: string
          legal_address: string | null
          state: string | null
          country: string | null
          gstin: string | null
          currency_code: string
          timezone: string
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          legal_name: string
          display_name: string
          company_code: string
          legal_address?: string | null
          state?: string | null
          country?: string | null
          gstin?: string | null
          currency_code?: string
          timezone?: string
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          legal_name?: string
          display_name?: string
          legal_address?: string | null
          state?: string | null
          country?: string | null
          gstin?: string | null
          timezone?: string
        }
        Relationships: []
      }
      company_settings: {
        Row: {
          id: string
          company_id: string
          setting_key: string
          setting_value: Json
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          company_id: string
          setting_key: string
          setting_value?: Json
          created_at?: string
          updated_at?: string
        }
        Update: {
          setting_value?: Json
        }
        Relationships: [
          {
            foreignKeyName: 'company_settings_company_id_fkey'
            columns: ['company_id']
            isOneToOne: false
            referencedRelation: 'companies'
            referencedColumns: ['id']
          },
        ]
      }
      profiles: {
        Row: {
          id: string
          full_name: string | null
          email: string
          company_id: string | null
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: never
        Update: {
          full_name?: string | null
          is_active?: boolean
        }
        Relationships: [
          {
            foreignKeyName: 'profiles_company_id_fkey'
            columns: ['company_id']
            isOneToOne: false
            referencedRelation: 'companies'
            referencedColumns: ['id']
          },
        ]
      }
      roles: {
        Row: {
          id: string
          code: string
          name: string
          description: string | null
          is_system: boolean
          created_at: string
          updated_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      permissions: {
        Row: {
          id: string
          resource: string
          action: string
          code: string
          description: string | null
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      role_permissions: {
        Row: {
          role_id: string
          permission_id: string
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: [
          {
            foreignKeyName: 'role_permissions_role_id_fkey'
            columns: ['role_id']
            isOneToOne: false
            referencedRelation: 'roles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'role_permissions_permission_id_fkey'
            columns: ['permission_id']
            isOneToOne: false
            referencedRelation: 'permissions'
            referencedColumns: ['id']
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          user_id: string
          company_id: string
          role_id: string
          assigned_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          company_id: string
          role_id: string
          assigned_by: string
          created_at?: string
        }
        Update: never
        Relationships: [
          {
            foreignKeyName: 'user_roles_role_id_fkey'
            columns: ['role_id']
            isOneToOne: false
            referencedRelation: 'roles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'user_roles_company_id_fkey'
            columns: ['company_id']
            isOneToOne: false
            referencedRelation: 'companies'
            referencedColumns: ['id']
          },
        ]
      }
      product_categories: {
        Row: {
          id: string
          company_id: string
          name: string
          code: string
          description: string | null
          is_active: boolean
          created_by: string | null
          updated_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          company_id: string
          name: string
          code: string
          description?: string | null
          is_active?: boolean
        }
        Update: {
          name?: string
          description?: string | null
          is_active?: boolean
        }
        Relationships: [
          {
            foreignKeyName: 'product_categories_company_id_fkey'
            columns: ['company_id']
            isOneToOne: false
            referencedRelation: 'companies'
            referencedColumns: ['id']
          },
        ]
      }
      products: {
        Row: {
          id: string
          company_id: string
          sku: string
          product_name: string
          description: string | null
          category_id: string | null
          brand: string | null
          model_number: string | null
          barcode: string | null
          product_image_path: string | null
          status: 'ACTIVE' | 'INACTIVE'
          archived_at: string | null
          archived_by: string | null
          product_type: 'RAW_MATERIAL' | 'FINISHED_GOOD' | 'COMPONENT' | 'SUBASSEMBLY' | 'OUTSOURCED_COMPONENT' | 'PACKAGING_MATERIAL' | 'CONSUMABLE' | 'OTHER'
          default_source_type: 'IN_HOUSE' | 'OUTSOURCED' | 'HYBRID'
          base_unit: string
          track_batches: boolean
          track_expiry: boolean
          inventory_tracked: boolean
          ean: string | null
          group_head: string | null
          minimum_cover_days: number | null
          change_reason: string | null
          hsn_code: string | null
          gst_rate: number | null
          selling_price: number | null
          standard_cost: number | null
          minimum_selling_price: number | null
          reorder_level: number | null
          preferred_supplier_id: string | null
          standard_manufacturing_cost: number | null
          minimum_level: number | null
          lead_time_days: number | null
          reorder_level_days: number | null
          mrp: number | null
          length_cm: number | null
          width_cm: number | null
          height_cm: number | null
          supplier_model_number: string | null
          supplier_product_name: string | null
          remarks: string | null
          is_manufacturable: boolean
          has_bom: boolean
          production_notes: string | null
          created_by: string | null
          updated_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          company_id: string
          sku?: string | null
          product_name: string
          description?: string | null
          category_id?: string | null
          brand?: string | null
          model_number?: string | null
          barcode?: string | null
          status?: 'ACTIVE' | 'INACTIVE'
          product_type: 'RAW_MATERIAL' | 'FINISHED_GOOD' | 'COMPONENT' | 'SUBASSEMBLY' | 'OUTSOURCED_COMPONENT' | 'PACKAGING_MATERIAL' | 'CONSUMABLE' | 'OTHER'
          default_source_type?: 'IN_HOUSE' | 'OUTSOURCED' | 'HYBRID'
          base_unit?: string
          track_batches?: boolean
          track_expiry?: boolean
          inventory_tracked?: boolean
          ean?: string | null
          group_head?: string | null
          minimum_cover_days?: number | null
          change_reason?: string | null
          hsn_code?: string | null
          gst_rate?: number | null
          selling_price?: number | null
          standard_cost?: number | null
          minimum_selling_price?: number | null
          reorder_level?: number | null
          standard_manufacturing_cost?: number | null
          minimum_level?: number | null
          lead_time_days?: number | null
          reorder_level_days?: number | null
          mrp?: number | null
          length_cm?: number | null
          width_cm?: number | null
          height_cm?: number | null
          supplier_model_number?: string | null
          supplier_product_name?: string | null
          preferred_supplier_id?: string | null
          remarks?: string | null
          is_manufacturable?: boolean
          has_bom?: boolean
          production_notes?: string | null
        }
        Update: {
          sku?: string
          product_name?: string
          description?: string | null
          category_id?: string | null
          brand?: string | null
          model_number?: string | null
          barcode?: string | null
          product_image_path?: string | null
          status?: 'ACTIVE' | 'INACTIVE'
          archived_at?: string | null
          product_type?: 'RAW_MATERIAL' | 'FINISHED_GOOD' | 'COMPONENT' | 'SUBASSEMBLY' | 'OUTSOURCED_COMPONENT' | 'PACKAGING_MATERIAL' | 'CONSUMABLE' | 'OTHER'
          default_source_type?: 'IN_HOUSE' | 'OUTSOURCED' | 'HYBRID'
          base_unit?: string
          track_batches?: boolean
          track_expiry?: boolean
          inventory_tracked?: boolean
          ean?: string | null
          group_head?: string | null
          minimum_cover_days?: number | null
          change_reason?: string | null
          hsn_code?: string | null
          gst_rate?: number | null
          selling_price?: number | null
          standard_cost?: number | null
          minimum_selling_price?: number | null
          reorder_level?: number | null
          standard_manufacturing_cost?: number | null
          minimum_level?: number | null
          lead_time_days?: number | null
          reorder_level_days?: number | null
          mrp?: number | null
          length_cm?: number | null
          width_cm?: number | null
          height_cm?: number | null
          supplier_model_number?: string | null
          supplier_product_name?: string | null
          preferred_supplier_id?: string | null
          remarks?: string | null
          is_manufacturable?: boolean
          has_bom?: boolean
          production_notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'products_company_id_fkey'
            columns: ['company_id']
            isOneToOne: false
            referencedRelation: 'companies'
            referencedColumns: ['id']
          },
        ]
      }
      warehouses: InventoryTables['warehouses']
      inventory_locations: InventoryTables['inventory_locations']
      inventory_batches: InventoryTables['inventory_batches']
      inventory_balances: InventoryTables['inventory_balances']
      inventory_transactions: InventoryTables['inventory_transactions']
      stock_reservations: InventoryTables['stock_reservations']
      inventory_opening_batches: InventoryTables['inventory_opening_batches']
      inventory_opening_lines: InventoryTables['inventory_opening_lines']
      inventory_adjustments: InventoryTables['inventory_adjustments']
      inventory_counts: InventoryTables['inventory_counts']
      inventory_count_lines: InventoryTables['inventory_count_lines']
      inventory_alerts: InventoryTables['inventory_alerts']
      boms: ProductionTables['boms']
      bom_items: ProductionTables['bom_items']
      production_orders: ProductionTables['production_orders']
      production_order_materials: ProductionTables['production_order_materials']
      production_material_consumption: ProductionTables['production_material_consumption']
      production_output_receipts: ProductionTables['production_output_receipts']
      production_order_events: ProductionTables['production_order_events']
      outsourcing_orders: ProductionTables['outsourcing_orders']
      outsourcing_order_materials: ProductionTables['outsourcing_order_materials']
      outsourcing_receipts: ProductionTables['outsourcing_receipts']
      outsourcing_material_movements: ProductionTables['outsourcing_material_movements']
      outsourcing_order_events: ProductionTables['outsourcing_order_events']
      customers: CustomerPoTables['customers']
      customer_product_codes: CustomerPoTables['customer_product_codes']
      customer_po_import_batches: CustomerPoTables['customer_po_import_batches']
      customer_purchase_orders: CustomerPoTables['customer_purchase_orders']
      customer_purchase_order_lines: CustomerPoTables['customer_purchase_order_lines']
      customer_po_events: CustomerPoTables['customer_po_events']
      customer_po_allocation_runs: CustomerPoTables['customer_po_allocation_runs']
      customer_po_analysis_snapshots: CustomerPoTables['customer_po_analysis_snapshots']
      customer_po_shortage_notes: CustomerPoTables['customer_po_shortage_notes']
      sales_orders: SalesTables['sales_orders']
      sales_order_lines: SalesTables['sales_order_lines']
      sales_order_events: SalesTables['sales_order_events']
      fulfilments: SalesTables['fulfilments']
      fulfilment_lines: SalesTables['fulfilment_lines']
      delivery_events: SalesTables['delivery_events']
      customer_returns: SalesTables['customer_returns']
      customer_return_lines: SalesTables['customer_return_lines']
      invoice_settings: BillingTables['invoice_settings']
      sales_invoices: BillingTables['sales_invoices']
      sales_invoice_lines: BillingTables['sales_invoice_lines']
      sales_invoice_dispatch_allocations: BillingTables['sales_invoice_dispatch_allocations']
      customer_payments: BillingTables['customer_payments']
      invoice_payment_allocations: BillingTables['invoice_payment_allocations']
      invoice_adjustment_notes: BillingTables['invoice_adjustment_notes']
      invoice_adjustment_note_lines: BillingTables['invoice_adjustment_note_lines']
      billing_events: BillingTables['billing_events']
      suppliers: SupplierTables['suppliers']
      purchase_orders: PurchasingTables['purchase_orders']
      purchase_order_lines: PurchasingTables['purchase_order_lines']
      purchase_order_events: PurchasingTables['purchase_order_events']
      purchase_order_amendments: PurchasingTables['purchase_order_amendments']
      goods_receipts: PurchasingTables['goods_receipts']
      goods_receipt_lines: PurchasingTables['goods_receipt_lines']
      audit_logs: {
        Row: {
          id: string
          company_id: string | null
          actor_user_id: string | null
          action: string
          resource_type: string
          resource_id: string | null
          event_timestamp: string
          request_id: string | null
          metadata: Json
        }
        Insert: never
        Update: never
        Relationships: []
      }
    }
    Views: InventoryViews & ProductionViews & CustomerPoViews & SalesViews & BillingViews & PurchasingViews
    Functions: InventoryFunctions & SupplierFunctions & {
      get_my_access: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      current_user_has_permission: {
        Args: { p_permission: string }
        Returns: boolean
      }
      log_security_event: {
        Args: { p_action: string; p_metadata?: Json }
        Returns: undefined
      }
      product_kpis: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      product_category_counts: {
        Args: Record<PropertyKey, never>
        Returns: { category_id: string; total_products: number; active_products: number }[]
      }
      check_product_identifiers: {
        Args: { p_skus: string[]; p_barcodes: string[] }
        Returns: { kind: 'sku' | 'barcode'; value: string; product_id: string; sku: string }[]
      }
      log_product_import: {
        Args: { p_file_name: string; p_total: number; p_imported: number; p_skipped: number; p_failed: number }
        Returns: undefined
      }
      user_display_names: {
        Args: { p_user_ids: string[] }
        Returns: { user_id: string; display_name: string }[]
      }
    }
    Enums: Record<never, never>
    CompositeTypes: Record<never, never>
  }
}

type PublicTables = Database['public']['Tables']
export type TableRow<T extends keyof PublicTables> = PublicTables[T]['Row']

export type CompanyRow = TableRow<'companies'>
export type CompanySettingRow = TableRow<'company_settings'>
export type ProfileRow = TableRow<'profiles'>
export type RoleRow = TableRow<'roles'>
export type UserRoleRow = TableRow<'user_roles'>
export type AuditLogRow = TableRow<'audit_logs'>
export type ProductRow = TableRow<'products'>
export type ProductCategoryRow = TableRow<'product_categories'>
