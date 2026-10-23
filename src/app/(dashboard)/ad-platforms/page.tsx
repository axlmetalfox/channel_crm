'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Megaphone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AdPlatformsPanel } from '@/components/ad-platforms/ad-platforms-panel';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';

export default function AdPlatformsPage() {
  const t = useTranslations('AdPlatforms');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { accountRole, profileLoading } = useAuth();
  const allowed = accountRole ? canEditSettings(accountRole) : false;
  // Connecting an ad account is for admins: anyone else is sent to the inbox.
  const blocked = !profileLoading && !allowed;
  useEffect(() => {
    if (blocked) router.replace('/inbox');
  }, [blocked, router]);

  if (!allowed) return null;

  return (
    <div>
      <div className="flex items-center gap-2">
        <Megaphone className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('title')}</h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      <AdPlatformsPanel returnedFromSignIn={searchParams.get('returned') === '1'} />
    </div>
  );
}
