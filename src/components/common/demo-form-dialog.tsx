import { Info } from 'lucide-react'
import { useId, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export interface DemoField {
  name: string
  label: string
  type?: 'text' | 'number' | 'date' | 'email' | 'select' | 'textarea'
  placeholder?: string
  options?: string[]
  /** Spans both columns of the form grid. */
  fullWidth?: boolean
}

interface DemoFormDialogProps {
  trigger: ReactNode
  title: string
  description: string
  fields: DemoField[]
  saveLabel?: string
}

/**
 * Frontend-only form preview for a module that is not built. Nothing is
 * submitted or stored: the save button is disabled and the dialog says so.
 */
export function DemoFormDialog({ trigger, title, description, fields, saveLabel = 'Save' }: DemoFormDialogProps) {
  const formId = useId()

  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-sm text-blue-900">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            Form preview only. This module is not part of the current ERP build, so nothing entered here is
            saved.
          </p>
        </div>

        <form id={formId} className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()}>
          {fields.map((field) => {
            const id = `${formId}-${field.name}`
            return (
              <div key={field.name} className={cn('space-y-1.5', field.fullWidth && 'sm:col-span-2')}>
                <Label htmlFor={id}>{field.label}</Label>
                {field.type === 'select' ? (
                  <Select>
                    <SelectTrigger id={id}>
                      <SelectValue placeholder={field.placeholder ?? 'Select…'} />
                    </SelectTrigger>
                    <SelectContent>
                      {(field.options ?? []).map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : field.type === 'textarea' ? (
                  <Textarea id={id} placeholder={field.placeholder} />
                ) : (
                  <Input id={id} type={field.type ?? 'text'} placeholder={field.placeholder} />
                )}
              </div>
            )
          })}
        </form>

        <DialogFooter className="items-center">
          <DialogClose asChild>
            <Button variant="outline">Close preview</Button>
          </DialogClose>
          <Button type="submit" form={formId} disabled title="Not available: this module is not built">
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
