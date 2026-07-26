/**
 * UN SOLO ORIGEN (fase 10b): toda la API vive bajo /api del mismo dominio
 * que el frontend (https://inbox.<dominio>/api/*). Decisión: /health/*
 * también va ADENTRO del prefijo — una sola regla de ruteo en el proxy y
 * cero excepciones que documentar; el healthcheck de Easypanel pega al
 * contenedor directo, así que el path da igual.
 */
export const API_PREFIX = 'api';
