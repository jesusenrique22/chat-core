/**
 * ============================================
 * Script de Pruebas de Flujo Completo: Agendador de Citas CPU
 * ============================================
 * Prueba las API REST de departamentos, disponibilidad, agendamiento de citas
 * y resolución por parte de los Jefes de Departamento.
 */

const http = require('http');

const PORT = process.env.PORT || 4000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runAppointmentFlowTests() {
  console.log('🚀 === INICIANDO TEST DE FLUJO DE CITAS CPU Y SERVICIOS MARACAIBO ===\n');

  try {
    // 1. Obtener lista de departamentos
    console.log('1️⃣ Obtener departamentos de CPU (/api/departments)...');
    const deptsRes = await makeRequest('GET', '/api/departments');
    if (deptsRes.status !== 200 || !deptsRes.body.success) {
      throw new Error(`Falló al obtener departamentos: ${JSON.stringify(deptsRes)}`);
    }
    console.log(`✅ Departamentos obtenidos (${deptsRes.body.count}):`);
    deptsRes.body.data.forEach(d => console.log(`   - [${d.code}] ${d.name} (${d.headName})`));
    const nomDept = deptsRes.body.data.find(d => d.code === 'NOM') || deptsRes.body.data[0];
    const valDept = deptsRes.body.data.find(d => d.code === 'VAL') || deptsRes.body.data[1];

    // 2. Consultar disponibilidad del departamento de Valuación
    console.log(`\n2️⃣ Consultar disponibilidad de ${valDept.name} para 2026-08-25...`);
    const availRes = await makeRequest('GET', `/api/departments/${valDept._id}/availability?date=2026-08-25`);
    if (availRes.status !== 200 || !availRes.body.success) {
      throw new Error(`Falló al obtener disponibilidad: ${JSON.stringify(availRes)}`);
    }
    console.log(`✅ Disponibilidad obtenida para ${availRes.body.data.department.name}:`);
    availRes.body.data.slots.slice(0, 3).forEach(s => console.log(`   - Horario: ${s.slot} | Libres: ${s.available}`));

    // 3. Crear una cita para resolución online (Caso 1: Valuación - Resuelto Online)
    console.log('\n3️⃣ Creando Cita 1 (Solicitud de Valor Fiscal de Inmueble - Resuelto Online)...');
    const appointmentPayload1 = {
      departmentId: valDept._id,
      taxpayer: {
        name: 'Jesús Enrique Ruiz',
        cedulaRif: 'V-25123456',
        email: 'jesus@maracaibo.gob.ve',
        phone: '0414-1234567'
      },
      subject: 'Solicitud de Valuación de Inmueble Urbano y Cálculo de Valor Fiscal',
      description: 'Requiero la valuación fiscal para la cancelación del impuesto municipal.',
      requestedDate: '2026-08-25',
      requestedTimeSlot: '09:00 - 10:00',
      attachments: [{ url: 'https://ejemplo.com/recaudo.pdf', filename: 'documento_propiedad.pdf' }]
    };
    const createRes1 = await makeRequest('POST', '/api/appointments', appointmentPayload1);
    if (createRes1.status !== 201 || !createRes1.body.success) {
      throw new Error(`Falló al crear Cita 1: ${JSON.stringify(createRes1)}`);
    }
    const cita1 = createRes1.body.data;
    console.log(`✅ Cita 1 creada exitosamente con código: ${cita1.appointmentCode} | Estatus: ${cita1.status}`);

    // 4. Crear una cita para consulta presencial (Caso 2: Nomenclatura - Cita Presencial)
    console.log('\n4️⃣ Creando Cita 2 (Asignación de Nomenclatura - Cita Presencial)...');
    const appointmentPayload2 = {
      departmentId: nomDept._id,
      taxpayer: {
        name: 'Empresa Constructora Zulia C.A.',
        cedulaRif: 'J-309876541',
        email: 'contacto@constructora.com',
        phone: '0424-7654321'
      },
      subject: 'Asignación de Código de Nomenclatura e Inmueble',
      description: 'Revisión de planos de loteo y asignación presencial de numeración.',
      requestedDate: '2026-08-25',
      requestedTimeSlot: '10:00 - 11:00'
    };
    const createRes2 = await makeRequest('POST', '/api/appointments', appointmentPayload2);
    if (createRes2.status !== 201 || !createRes2.body.success) {
      throw new Error(`Falló al crear Cita 2: ${JSON.stringify(createRes2)}`);
    }
    const cita2 = createRes2.body.data;
    console.log(`✅ Cita 2 creada exitosamente con código: ${cita2.appointmentCode} | Estatus: ${cita2.status}`);

    // 5. Consultar estatus público por código
    console.log(`\n5️⃣ Consultar estatus público de la Cita ${cita1.appointmentCode}...`);
    const trackRes = await makeRequest('GET', `/api/appointments/track/${cita1.appointmentCode}`);
    if (trackRes.status !== 200 || !trackRes.body.success) {
      throw new Error(`Falló al rastrear cita: ${JSON.stringify(trackRes)}`);
    }
    console.log(`✅ Cita encontrada: ${trackRes.body.data.subject} | Contribuyente: ${trackRes.body.data.taxpayer.name}`);

    // 6. Consultar bandeja del Jefe de Valuación
    console.log(`\n6️⃣ Jefe de Valuación consulta su bandeja de entrada (/api/appointments/department/${valDept._id})...`);
    const inboxRes = await makeRequest('GET', `/api/appointments/department/${valDept._id}`);
    if (inboxRes.status !== 200 || !inboxRes.body.success) {
      throw new Error(`Falló consulta de bandeja: ${JSON.stringify(inboxRes)}`);
    }
    console.log(`✅ Bandeja de ${valDept.name} tiene ${inboxRes.body.count} citas pendientes.`);

    // 7. Jefe de Valuación responde a Cita 1: "CASO RESUELTO ONLINE"
    console.log(`\n7️⃣ Jefe de Valuación (Edwin) responde a Cita 1 (${cita1.appointmentCode}) -> RESUELTO_ONLINE...`);
    const respondPayload1 = {
      resolvedBy: valDept.headName,
      resolutionType: 'RESUELTO_ONLINE',
      notes: 'La valuación fiscal de su inmueble fue realizada exitosamente. Se envió el comprobante del valor fiscal a su correo.'
    };
    const targetId1 = cita1.id || cita1._id;
    const respondRes1 = await makeRequest('PATCH', `/api/appointments/${targetId1}/respond`, respondPayload1);
    if (respondRes1.status !== 200 || !respondRes1.body.success) {
      throw new Error(`Falló al responder Cita 1: ${JSON.stringify(respondRes1)}`);
    }
    console.log(`✅ Cita 1 actualizada exitosamente: Nuevo Estatus = ${respondRes1.body.data.status}`);
    console.log(`   Notas del Jefe: "${respondRes1.body.data.notes || respondRes1.body.data.resolution?.notes}"`);

    // 8. Jefe de Nomenclatura responde a Cita 2: "DEBE ACERCARSE (CONFIRMADA PRESENCIAL)"
    console.log(`\n8️⃣ Responsables de Nomenclatura (Edeana / Karina) responden a Cita 2 (${cita2.appointmentCode}) -> CONFIRMADA_PRESENCIAL...`);
    const respondPayload2 = {
      resolvedBy: nomDept.headName,
      resolutionType: 'CONFIRMADA_PRESENCIAL',
      notes: 'Estimado contribuyente, su cita presencial fue confirmada. Acérquese a la taquilla de Nomenclatura con los documentos originales.'
    };
    const targetId2 = cita2.id || cita2._id;
    const respondRes2 = await makeRequest('PATCH', `/api/appointments/${targetId2}/respond`, respondPayload2);
    if (respondRes2.status !== 200 || !respondRes2.body.success) {
      throw new Error(`Falló al responder Cita 2: ${JSON.stringify(respondRes2)}`);
    }
    console.log(`✅ Cita 2 actualizada exitosamente: Nuevo Estatus = ${respondRes2.body.data.status}`);
    console.log(`   Notas del Jefe: "${respondRes2.body.data.notes || respondRes2.body.data.resolution?.notes}"`);
    const qrUrl = respondRes2.body.data.qrCodeUrl || respondRes2.body.data.resolution?.qrCodeUrl || '';
    console.log(`   Pase Digital QR: ${qrUrl.substring(0, 70)}...`);

    console.log('\n🎉 === TODOS LOS TESTS DE CITAS Y RESPUESTA DE JEFES DE DEPARTAMENTO PASARON EXITOSAMENTE === 🎉');
  } catch (err) {
    console.error('\n❌ ERROR EN EL TEST DE CITAS:', err.message);
    process.exit(1);
  }
}

runAppointmentFlowTests();
