import { useUserRoles } from '@/contexts/auth';
import { getPath } from '@/routes/paths';
import { CURRENT_SPACE, getItem, setItem } from '@/utils/local-storage';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { UserRole } from '@openathlete/shared';

import { SpaceContextType } from '../types';
import { SpaceContext } from './space-context';

type Props = {
  children: React.ReactNode;
};

export function SpaceProvider({ children }: Props) {
  const roles = useUserRoles();
  const [currentSpace, setCurrentSpace] = useState<UserRole>(() => {
    const storedSpace = getItem(CURRENT_SPACE);
    return storedSpace ? (storedSpace as UserRole) : 'ATHLETE';
  });
  const nav = useNavigate();

  // A user only holds the roles they selected during onboarding, so fall back
  // to a space they actually have when the stored one is not available.
  const space =
    !roles || roles.length === 0 || roles.includes(currentSpace)
      ? currentSpace
      : roles[0];

  const handleSpaceChange = useCallback(
    (space: UserRole) => {
      setCurrentSpace(space);
      setItem(CURRENT_SPACE, space);
      if (space === 'COACH') {
        nav(getPath(['dashboard', 'coach']));
      } else {
        nav(getPath(['dashboard', 'calendar']));
      }
    },
    [nav],
  );

  const memoizedValue = useMemo<SpaceContextType>(
    () => ({
      space,
      setSpace: handleSpaceChange,
    }),
    [space, handleSpaceChange],
  );

  return (
    <SpaceContext.Provider value={memoizedValue}>
      {children}
    </SpaceContext.Provider>
  );
}
