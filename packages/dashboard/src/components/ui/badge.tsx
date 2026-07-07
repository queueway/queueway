import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        completed: 'bg-emerald-950 text-emerald-400',
        failed: 'bg-red-950 text-red-400',
        pending: 'bg-amber-950 text-amber-400',
        processing: 'bg-blue-950 text-blue-400',
        retrying: 'bg-purple-950 text-purple-400',
        archived: 'bg-zinc-800 text-zinc-400',
      },
    },
    defaultVariants: {
      variant: 'pending',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
