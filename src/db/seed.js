/**
 * Seeds two demo patients so the dashboard and API are not empty on first
 * look. Idempotent: re-running does nothing if the records already exist.
 *
 *   npm run seed
 */
import { createPatient, findPatientsByPhone } from '../domain/patient.service.js';
import { logger } from '../lib/logger.js';
import { closeDb } from './index.js';

const SEEDS = [
  {
    first_name: 'Jane',
    last_name: 'Doe',
    date_of_birth: '04/12/1986',
    sex: 'Female',
    phone_number: '2125550142',
    email: 'jane.doe@example.com',
    address_line_1: '118 Riverside Drive',
    address_line_2: 'Apt 4B',
    city: 'New York',
    state: 'NY',
    zip_code: '10024',
    insurance_provider: 'Aetna',
    insurance_member_id: 'AET4471902',
    preferred_language: 'English',
    emergency_contact_name: 'Michael Doe',
    emergency_contact_phone: '2125550188',
  },
  {
    first_name: 'Carlos',
    last_name: 'Ramirez',
    date_of_birth: '11/30/1974',
    sex: 'Male',
    phone_number: '3055550119',
    address_line_1: '2400 Coral Way',
    city: 'Miami',
    state: 'FL',
    zip_code: '33145',
    preferred_language: 'Spanish',
  },
];

let created = 0;
for (const seed of SEEDS) {
  if ((await findPatientsByPhone(seed.phone_number)).length > 0) {
    logger.info('seed skipped (already present)', { last_name: seed.last_name });
    continue;
  }
  const patient = await createPatient(seed);
  created += 1;
  logger.info('seed created', { patient_id: patient.patient_id, last_name: patient.last_name });
}

logger.info('seeding complete', { created });
await closeDb();
