-- ADV-002: platform.administer also gates tenant/workspace bootstrap.
UPDATE roles
SET description = 'Platform-scoped operations (tenant/workspace bootstrap and global embed overlap key rotation). Not assignable via workspace membership; granted only by PLATFORM_ADMINS.'
WHERE key = 'platform-admin';
