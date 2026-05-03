interface Props {
  size?: 'sm' | 'md' | 'lg'
  text?: string
}

const sizes = { sm: 'w-5 h-5', md: 'w-8 h-8', lg: 'w-12 h-12' }

export default function LoadingSpinner({ size = 'md', text }: Props) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12">
      <div className={`${sizes[size]} border-2 border-slate-700 border-t-brand-500 rounded-full spinner`} />
      {text && <p className="text-sm text-slate-500">{text}</p>}
    </div>
  )
}
