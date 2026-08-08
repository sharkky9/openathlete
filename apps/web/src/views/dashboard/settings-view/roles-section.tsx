import { useUpdateAccountMutation } from '@/api/user';
import { userKeys } from '@/api/user/user.keys';
import { Button } from '@/components/ui/button';
import { useAuthContext } from '@/contexts/auth';
import { m } from '@/paraglide/messages';
import { cn } from '@/utils/shadcn';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { SettingsSection } from './settings-section';

type Role = 'ATHLETE' | 'COACH';

const ROLES: { value: Role; label: () => string }[] = [
  { value: 'ATHLETE', label: () => m.onboarding_role_athlete() },
  { value: 'COACH', label: () => m.onboarding_role_coach() },
];

/**
 * Lets an account change its roles after onboarding.
 *
 * `completeOnboarding` used to be the only writer of `roles`, and `AuthGuard`
 * only routes to onboarding while `onboardingCompleted` is false, so an account
 * that picked "I'm an athlete" once was athlete-only forever. This section is
 * deliberately not role-gated (unlike the Athletes/Coaches tabs) — the whole
 * point is to be reachable by a user who does not yet have the role they want.
 */
export function RolesSection() {
  const { user, initialize } = useAuthContext();
  const queryClient = useQueryClient();
  const [selectedRoles, setSelectedRoles] = useState<Role[]>(
    (user?.roles as Role[] | undefined) ?? [],
  );

  // `user` arrives asynchronously from AuthProvider, so seed from it once it is
  // there rather than leaving the toggles stuck on the initial empty array.
  useEffect(() => {
    if (user?.roles) {
      setSelectedRoles(user.roles as Role[]);
    }
  }, [user?.roles]);

  const updateRolesMutation = useUpdateAccountMutation({
    onSuccess: async () => {
      // `useUserRoles`, `SpaceProvider` and the sidebar space switcher all read
      // from the AuthProvider user, which is fetched outside React Query, so
      // both caches have to be refreshed for the change to be visible.
      await queryClient.invalidateQueries({ queryKey: [userKeys.getMe] });
      await initialize();
      toast.success(m.account_updated_successfully());
    },
    onError: () => {
      toast.error(m.settings_roles_update_failed());
    },
  });

  const toggleRole = (role: Role) => {
    setSelectedRoles((current) =>
      current.includes(role)
        ? current.filter((value) => value !== role)
        : [...current, role],
    );
  };

  const handleSave = () => {
    if (selectedRoles.length === 0) {
      toast.error(m.settings_roles_select_at_least_one());
      return;
    }

    updateRolesMutation.mutate({ roles: selectedRoles });
  };

  const isUnchanged =
    user?.roles !== undefined &&
    user.roles.length === selectedRoles.length &&
    selectedRoles.every((role) => (user.roles as Role[]).includes(role));

  return (
    <SettingsSection
      title={m.settings_roles()}
      description={m.settings_roles_description()}
    >
      <div className="flex w-full max-w-md flex-col gap-4">
        <div className="grid gap-3">
          {ROLES.map(({ value, label }) => {
            const isSelected = selectedRoles.includes(value);
            return (
              <button
                key={value}
                type="button"
                aria-pressed={isSelected}
                onClick={() => toggleRole(value)}
                className={cn(
                  'flex items-center gap-3 rounded-lg border-2 p-3 text-left transition-colors',
                  isSelected
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:border-primary/50',
                )}
              >
                <CheckCircle2
                  className={cn(
                    'h-5 w-5',
                    isSelected ? 'text-primary' : 'text-muted-foreground',
                  )}
                />
                <span className="font-medium">{label()}</span>
              </button>
            );
          })}
        </div>
        <Button
          type="button"
          className="w-fit"
          onClick={handleSave}
          disabled={isUnchanged || selectedRoles.length === 0}
          isLoading={updateRolesMutation.isPending}
        >
          {m.update()}
        </Button>
      </div>
    </SettingsSection>
  );
}
