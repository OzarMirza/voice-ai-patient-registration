/**
 * REST API for patient records.
 *
 *   GET    /patients          list + filter (?last_name= ?date_of_birth= ?phone_number=)
 *   GET    /patients/:id      fetch one
 *   POST   /patients          create
 *   PUT    /patients/:id      partial update
 *   DELETE /patients/:id      soft delete
 *
 * Routes stay thin: parse the request, call the service, shape the response.
 * All validation lives in the domain layer so the voice agent gets the same
 * rules for free.
 */
import { Router } from 'express';
import { asyncRoute } from '../middleware/error.js';
import { requireApiKey } from '../middleware/security.js';
import { BadRequestError } from '../lib/errors.js';
import {
  createPatient,
  getPatientById,
  listAppointments,
  listCalls,
  listPatients,
  softDeletePatient,
  updatePatient,
} from '../domain/patient.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(id) {
  if (!UUID_RE.test(id)) {
    throw new BadRequestError('patient_id must be a UUID', [
      { field: 'patient_id', message: `"${id}" is not a valid UUID` },
    ]);
  }
}

export const patientsRouter = Router();

patientsRouter.get(
  '/',
  asyncRoute((req, res) => {
    const { patients, pagination } = listPatients(req.query);
    res.ok({ patients, pagination });
  }),
);

patientsRouter.get(
  '/:id',
  asyncRoute((req, res) => {
    assertUuid(req.params.id);
    const patient = getPatientById(req.params.id);
    if (!patient) return res.fail(404, 'not_found', `No patient found with id ${req.params.id}`);
    return res.ok(patient);
  }),
);

/** Related sub-resources — used by the dashboard detail drawer. */
patientsRouter.get(
  '/:id/calls',
  asyncRoute((req, res) => {
    assertUuid(req.params.id);
    res.ok({ calls: listCalls({ patientId: req.params.id }) });
  }),
);

patientsRouter.get(
  '/:id/appointments',
  asyncRoute((req, res) => {
    assertUuid(req.params.id);
    res.ok({ appointments: listAppointments(req.params.id) });
  }),
);

patientsRouter.post(
  '/',
  requireApiKey,
  asyncRoute((req, res) => {
    const patient = createPatient(req.body);
    res.set('Location', `/patients/${patient.patient_id}`);
    res.ok(patient, 201);
  }),
);

patientsRouter.put(
  '/:id',
  requireApiKey,
  asyncRoute((req, res) => {
    assertUuid(req.params.id);
    res.ok(updatePatient(req.params.id, req.body));
  }),
);

// PATCH is a synonym here: the brief specifies PUT with partial updates
// allowed, which is PATCH semantics, so both verbs are accepted.
patientsRouter.patch(
  '/:id',
  requireApiKey,
  asyncRoute((req, res) => {
    assertUuid(req.params.id);
    res.ok(updatePatient(req.params.id, req.body));
  }),
);

patientsRouter.delete(
  '/:id',
  requireApiKey,
  asyncRoute((req, res) => {
    assertUuid(req.params.id);
    const patient = softDeletePatient(req.params.id);
    res.ok({ patient_id: patient.patient_id, deleted_at: patient.deleted_at, soft_deleted: true });
  }),
);
