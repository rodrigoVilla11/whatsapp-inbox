-- Rol de aplicación: NO superusuario, NO BYPASSRLS.
-- Preparación para Row-Level Security: la app se conecta SIEMPRE con este rol.
-- CREATEDB es solo para la shadow database de `prisma migrate dev` en desarrollo;
-- CREATEDB no otorga bypass de RLS (solo SUPERUSER o BYPASSRLS lo hacen).
-- En producción: el runtime usa app_user y las migraciones corren con un rol
-- privilegiado separado (ver README, sección RLS).
CREATE ROLE app_user LOGIN PASSWORD 'app_password' CREATEDB;

CREATE DATABASE whatsapp_inbox OWNER app_user;
