import type { ComponentProps, ReactNode } from "react"
import { AlertCircle, CheckCircle2, LoaderCircle, RefreshCw, Trash2 } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export function AdminFeedback({ error, notice }: { error?: string; notice?: string }) {
  if (!error && !notice) return null
  const isError = Boolean(error)
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm",
        isError
          ? "border-destructive/25 bg-destructive/5 text-destructive"
          : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
      )}
      role={isError ? "alert" : "status"}
    >
      {isError ? <AlertCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
      <span>{error || notice}</span>
    </div>
  )
}

export function AdminLoading({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
      <LoaderCircle className="size-5 animate-spin text-primary" />
      {label}
    </div>
  )
}

type AdminSubmitButtonProps = Omit<ComponentProps<typeof Button>, "type"> & {
  pending: boolean
}

export function AdminSubmitButton({ pending, children, disabled, ...props }: AdminSubmitButtonProps) {
  return (
    <Button type="submit" disabled={pending || disabled} {...props}>
      {pending ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : null}
      {pending ? "正在保存…" : children}
    </Button>
  )
}

export function ReloadButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <Button variant="outline" onClick={onClick} disabled={loading}>
      <RefreshCw className={cn(loading && "animate-spin")} data-icon="inline-start" />
      刷新
    </Button>
  )
}

export function ConfirmButton({
  title,
  description,
  confirmLabel = "确认删除",
  onConfirm,
  children,
  disabled,
}: {
  title: string
  description: string
  confirmLabel?: string
  onConfirm: () => void
  children?: ReactNode
  disabled?: boolean
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={disabled}>
          {children ?? (
            <>
              <Trash2 data-icon="inline-start" />
              删除
            </>
          )}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function FormField({
  label,
  name,
  defaultValue,
  type = "text",
  required,
  readOnly,
  placeholder,
  min,
  max,
  step,
  description,
}: {
  label: string
  name: string
  defaultValue?: string | number
  type?: "text" | "password" | "url" | "number" | "time" | "datetime-local"
  required?: boolean
  readOnly?: boolean
  placeholder?: string
  min?: number
  max?: number
  step?: number
  description?: string
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        readOnly={readOnly}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
      />
      {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
    </div>
  )
}

export function TextareaField({
  label,
  name,
  defaultValue,
  required,
  rows = 4,
  placeholder,
  description,
}: {
  label: string
  name: string
  defaultValue?: string
  required?: boolean
  rows?: number
  placeholder?: string
  description?: string
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <Textarea
        id={name}
        name={name}
        defaultValue={defaultValue}
        required={required}
        rows={rows}
        placeholder={placeholder}
      />
      {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
    </div>
  )
}

export function SelectField({
  label,
  name,
  defaultValue,
  value,
  options,
  description,
  onValueChange,
}: {
  label: string
  name: string
  defaultValue?: string
  value?: string
  options: Array<{ value: string; label: string }>
  description?: string
  onValueChange?: (value: string) => void
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <select
        id={name}
        name={name}
        {...(value === undefined ? { defaultValue } : { value })}
        onChange={onValueChange ? (event) => onValueChange(event.target.value) : undefined}
        className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
    </div>
  )
}

export function CheckboxField({
  label,
  name,
  defaultChecked,
  description,
}: {
  label: string
  name: string
  defaultChecked?: boolean
  description?: string
}) {
  return (
    <label className="flex items-start gap-3 rounded-lg border bg-muted/20 p-3">
      <input
        name={name}
        type="checkbox"
        defaultChecked={defaultChecked}
        className="mt-0.5 size-4 rounded border-input accent-primary"
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {description ? <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span> : null}
      </span>
    </label>
  )
}
