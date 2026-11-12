// Carga OPCIONAL de una biblioteca base de ejercicios comunes para un gimnasio.
// Uso: node scripts/seed-exercises.js --gym <gym_id>
// - Contenido técnico general de uso habitual en entrenamiento de fuerza; el equipo del gimnasio debe revisarlo y adaptarlo.
// - No incluye imágenes ni videos: el administrador debe añadir sus propios medios (no se inventan URLs).
// - No sobrescribe ejercicios existentes con el mismo nombre.
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const E = (name, primary, secondary, equipment, movement, level, execution, breathing, errors, variations, alternatives, contraindications) =>
  ({ name, primary, secondary, equipment, movement, level, execution, breathing, errors, variations, alternatives, contraindications });

const EXERCISES = [
  E('Sentadilla goblet', ['cuádriceps', 'glúteo'], ['aductores', 'core'], ['dumbbells', 'kettlebells'], 'sentadilla', 'beginner',
    'Sostén la mancuerna pegada al pecho, pies a la anchura de los hombros. Desciende llevando la cadera atrás y abajo, rodillas en la dirección de los pies, torso erguido. Sube empujando el suelo con todo el pie.',
    'Inhala al bajar, exhala al subir pasando el punto de mayor esfuerzo.', ['Rodillas hacia dentro', 'Talones que se levantan', 'Redondear la espalda baja'],
    ['Con pausa abajo', 'Tempo lento'], ['Prensa de piernas', 'Sentadilla a banco'], ['Dolor agudo de rodilla o cadera durante el movimiento']),
  E('Sentadilla trasera con barra', ['cuádriceps', 'glúteo'], ['aductores', 'erectores espinales', 'core'], ['barbell', 'rack'], 'sentadilla', 'intermediate',
    'Barra sobre el trapecio, agarre firme, pies a la anchura de los hombros o algo más. Bracea el abdomen, desciende controlado hasta la profundidad que permita mantener la espalda neutra y sube manteniendo la barra sobre el medio del pie.',
    'Toma aire y bracea antes de bajar; mantén la presión y exhala al terminar la subida.', ['Perder la neutralidad lumbar', 'Rodillas en valgo', 'Desplazar el peso a la punta de los pies'],
    ['Sentadilla frontal', 'Sentadilla con pausa'], ['Sentadilla goblet', 'Prensa de piernas'], ['Lesión lumbar activa', 'Dolor de hombro que impida sostener la barra']),
  E('Prensa de piernas', ['cuádriceps', 'glúteo'], ['isquiotibiales'], ['machines'], 'empuje de piernas', 'beginner',
    'Espalda y glúteos apoyados en el respaldo, pies en la plataforma a la anchura de la cadera. Baja la plataforma controlando hasta donde la pelvis no se despegue y empuja sin bloquear las rodillas de golpe.',
    'Inhala al bajar, exhala al empujar.', ['Despegar la pelvis del asiento', 'Bloquear las rodillas bruscamente', 'Rango demasiado corto'],
    ['Pies altos (más glúteo)', 'Unilateral'], ['Sentadilla goblet', 'Zancadas'], ['Dolor lumbar al flexionar la cadera en profundidad']),
  E('Peso muerto rumano con mancuernas', ['isquiotibiales', 'glúteo'], ['erectores espinales'], ['dumbbells'], 'bisagra de cadera', 'beginner',
    'De pie con las mancuernas delante de los muslos, rodillas ligeramente flexionadas. Lleva la cadera atrás deslizando las mancuernas cerca de las piernas, espalda neutra, hasta sentir tensión en isquiotibiales. Vuelve extendiendo la cadera.',
    'Inhala al bajar, exhala al subir.', ['Redondear la espalda', 'Flexionar demasiado las rodillas', 'Separar las mancuernas del cuerpo'],
    ['Con barra', 'A una pierna'], ['Puente de glúteo', 'Curl femoral en máquina'], ['Hernia discal sintomática', 'Dolor lumbar agudo']),
  E('Hip thrust con barra', ['glúteo'], ['isquiotibiales'], ['barbell', 'bench'], 'extensión de cadera', 'beginner',
    'Espalda alta apoyada en el banco, barra sobre la cadera con protección. Empuja con los talones hasta alinear hombros, cadera y rodillas; mantén el mentón recogido y la pelvis en retroversión al final.',
    'Exhala al subir, inhala al bajar.', ['Hiperextender la zona lumbar', 'Pies demasiado lejos o cerca', 'Rango incompleto'],
    ['Con pausa arriba', 'Unilateral'], ['Puente de glúteo en suelo', 'Patada de glúteo en polea'], ['Molestia lumbar que aumenta con la extensión']),
  E('Zancada con mancuernas', ['cuádriceps', 'glúteo'], ['aductores', 'core'], ['dumbbells'], 'unilateral de piernas', 'beginner',
    'Da un paso largo, desciende hasta que ambas rodillas estén cerca de 90°, torso erguido y rodilla delantera alineada con el pie. Empuja con la pierna delantera para volver.',
    'Inhala al bajar, exhala al subir.', ['Rodilla delantera hacia dentro', 'Paso demasiado corto', 'Perder el equilibrio por apoyo estrecho'],
    ['Zancada atrás', 'Búlgara con pie elevado'], ['Step-up a banco', 'Prensa unilateral'], ['Dolor de rodilla al flexionar con carga']),
  E('Press de banca con barra', ['pectoral'], ['tríceps', 'deltoides anterior'], ['barbell', 'bench', 'rack'], 'empuje horizontal', 'intermediate',
    'Tumbado con ojos bajo la barra, escápulas retraídas y deprimidas, pies firmes. Baja la barra controlada a la parte baja del pecho con los codos a unos 45–70° del torso y empuja hasta extender.',
    'Inhala al bajar, exhala al empujar.', ['Codos totalmente abiertos a 90°', 'Rebotar la barra en el pecho', 'Levantar los glúteos del banco'],
    ['Inclinado', 'Agarre cerrado'], ['Press con mancuernas', 'Flexiones'], ['Dolor de hombro anterior al bajar la barra']),
  E('Press de banca con mancuernas', ['pectoral'], ['tríceps', 'deltoides anterior'], ['dumbbells', 'bench'], 'empuje horizontal', 'beginner',
    'Tumbado con las mancuernas a la altura del pecho, escápulas retraídas. Empuja hacia arriba convergiendo ligeramente y baja controlando hasta sentir estiramiento cómodo del pectoral.',
    'Inhala al bajar, exhala al empujar.', ['Bajar sin control', 'Perder la retracción escapular', 'Chocar las mancuernas arriba'],
    ['Inclinado', 'Agarre neutro'], ['Press en máquina', 'Flexiones'], ['Inestabilidad o dolor de hombro']),
  E('Flexiones de brazos', ['pectoral'], ['tríceps', 'deltoides anterior', 'core'], ['bodyweight'], 'empuje horizontal', 'beginner',
    'Manos algo más abiertas que los hombros, cuerpo en línea de cabeza a talones. Baja el pecho hacia el suelo con codos a unos 45° y empuja hasta extender los brazos.',
    'Inhala al bajar, exhala al subir.', ['Cadera caída', 'Codos a 90°', 'Rango incompleto'],
    ['Inclinadas (manos elevadas)', 'Con pausa'], ['Press de banca con mancuernas'], ['Dolor de muñeca en extensión (usar agarres o puños)']),
  E('Remo con mancuerna a una mano', ['dorsal ancho'], ['romboides', 'bíceps', 'deltoides posterior'], ['dumbbells', 'bench'], 'tracción horizontal', 'beginner',
    'Apoya mano y rodilla en el banco, espalda neutra. Tira de la mancuerna hacia la cadera llevando el codo atrás y abajo, sin rotar el torso. Baja estirando por completo.',
    'Exhala al tirar, inhala al bajar.', ['Rotar el torso', 'Tirar solo con el brazo', 'Encoger el hombro'],
    ['Remo apoyado en banco inclinado'], ['Remo en polea baja', 'Remo en máquina'], ['Dolor lumbar en posición inclinada sin apoyo']),
  E('Jalón al pecho en polea', ['dorsal ancho'], ['bíceps', 'romboides', 'trapecio inferior'], ['cables', 'machines'], 'tracción vertical', 'beginner',
    'Sentado con muslos fijos, agarre algo más ancho que los hombros. Lleva la barra hacia la parte alta del pecho deprimiendo las escápulas y llevando los codos hacia abajo. Sube controlando.',
    'Exhala al tirar, inhala al subir.', ['Balancear el torso', 'Llevar la barra detrás de la nuca', 'No completar la extensión arriba'],
    ['Agarre neutro', 'Unilateral'], ['Dominadas asistidas', 'Remo en polea'], ['Dolor de hombro en elevación completa']),
  E('Dominadas', ['dorsal ancho'], ['bíceps', 'romboides', 'core'], ['pullup_bar'], 'tracción vertical', 'advanced',
    'Cuélgate con agarre prono algo más ancho que los hombros. Inicia deprimiendo las escápulas y sube hasta que el mentón pase la barra sin balanceo. Baja controlado hasta extender.',
    'Exhala al subir, inhala al bajar.', ['Balanceo o impulso', 'Medio rango', 'Hombros encogidos'],
    ['Agarre supino', 'Con lastre'], ['Jalón al pecho', 'Dominadas asistidas con banda'], ['Lesión de hombro o codo activa']),
  E('Remo sentado en polea baja', ['dorsal ancho', 'romboides'], ['bíceps', 'deltoides posterior'], ['cables'], 'tracción horizontal', 'beginner',
    'Sentado con el torso erguido y rodillas ligeramente flexionadas. Tira del agarre hacia el abdomen juntando escápulas sin inclinarte atrás. Vuelve estirando los brazos con control.',
    'Exhala al tirar, inhala al volver.', ['Balancear el torso', 'Encoger hombros', 'Redondear la espalda al volver'],
    ['Agarre ancho', 'Unilateral'], ['Remo con mancuerna', 'Remo en máquina'], ['Dolor lumbar al mantener la postura sentada']),
  E('Press militar con mancuernas', ['deltoides anterior', 'deltoides medio'], ['tríceps', 'core'], ['dumbbells', 'bench'], 'empuje vertical', 'intermediate',
    'Sentado o de pie con abdomen activo, mancuernas a la altura de los hombros. Empuja hacia arriba sin arquear la zona lumbar y baja hasta la altura de las orejas o el mentón.',
    'Exhala al empujar, inhala al bajar.', ['Arquear la espalda baja', 'Bajar demasiado rápido', 'Codos muy por delante o detrás'],
    ['Alterno', 'Agarre neutro'], ['Press en máquina', 'Elevaciones laterales'], ['Pinzamiento o dolor de hombro por encima de la cabeza']),
  E('Elevaciones laterales con mancuernas', ['deltoides medio'], ['trapecio superior'], ['dumbbells'], 'aislamiento de hombro', 'beginner',
    'De pie con codos ligeramente flexionados. Eleva los brazos lateralmente hasta la altura de los hombros, guiando con los codos, y baja lento.',
    'Exhala al subir, inhala al bajar.', ['Usar impulso', 'Subir por encima de los hombros encogiendo', 'Peso excesivo'],
    ['En polea', 'Sentado'], ['Elevación lateral en máquina'], ['Dolor de hombro en abducción']),
  E('Curl de bíceps con mancuernas', ['bíceps'], ['braquial', 'antebrazo'], ['dumbbells'], 'aislamiento de brazo', 'beginner',
    'De pie con codos pegados al torso. Flexiona los codos girando la palma hacia arriba y baja controlando hasta extender.',
    'Exhala al subir, inhala al bajar.', ['Balancear el cuerpo', 'Adelantar los codos', 'Bajar sin control'],
    ['Martillo', 'Inclinado en banco'], ['Curl en polea', 'Curl con barra'], ['Dolor de codo (epicondilitis) que aumenta con la carga']),
  E('Extensión de tríceps en polea', ['tríceps'], [], ['cables'], 'aislamiento de brazo', 'beginner',
    'De pie frente a la polea alta, codos fijos junto al torso. Extiende los codos hasta abajo y vuelve controlando sin mover los hombros.',
    'Exhala al extender, inhala al volver.', ['Mover los codos', 'Inclinarse demasiado', 'Rango incompleto'],
    ['Con cuerda', 'Unilateral'], ['Fondos en banco', 'Press francés'], ['Dolor de codo']),
  E('Curl femoral en máquina', ['isquiotibiales'], ['gemelos'], ['machines'], 'aislamiento de pierna', 'beginner',
    'Ajusta la máquina para alinear la rodilla con el eje. Flexiona llevando el rodillo hacia los glúteos sin despegar la cadera y vuelve lento.',
    'Exhala al flexionar, inhala al volver.', ['Levantar la cadera', 'Rebotar al final', 'Rango corto'],
    ['Sentado', 'Unilateral'], ['Peso muerto rumano', 'Curl nórdico asistido'], ['Lesión reciente de isquiotibiales']),
  E('Plancha frontal', ['core'], ['glúteo', 'deltoides'], ['bodyweight'], 'estabilidad de tronco', 'beginner',
    'Antebrazos bajo los hombros, cuerpo en línea recta, glúteos y abdomen activos. Mantén la posición sin hundir ni elevar la cadera.',
    'Respira de forma continua y controlada, sin bloquear el aire.', ['Cadera caída', 'Cadera muy alta', 'Contener la respiración'],
    ['Con apoyo de rodillas', 'Con elevación de pierna'], ['Dead bug', 'Pallof press en polea'], ['Dolor lumbar durante la sujeción']),
  E('Bicicleta estática', ['cuádriceps'], ['glúteo', 'isquiotibiales', 'sistema cardiovascular'], ['cardio_machines'], 'cardio', 'beginner',
    'Ajusta el sillín para que la rodilla quede ligeramente flexionada abajo. Pedalea con cadencia constante a la intensidad indicada por el plan.',
    'Respiración rítmica acorde a la intensidad.', ['Sillín demasiado bajo', 'Balancear la cadera'],
    ['Intervalos', 'Continuo suave'], ['Elíptica', 'Caminata en cinta'], ['Síntomas cardiovasculares durante el esfuerzo (detener y consultar)']),
];

const gymId = process.argv[process.argv.indexOf('--gym') + 1];
if (!gymId || process.argv.indexOf('--gym') === -1) { console.error('Uso: node scripts/seed-exercises.js --gym <gym_id>'); process.exit(1); }
await migrate({ log: () => {} });
let inserted = 0;
for (const e of EXERCISES) {
  const r = await pool.query(
    `INSERT INTO exercises (gym_id, name, primary_muscles, secondary_muscles, equipment, movement_type, level, execution, breathing,
       common_errors, variations, alternatives, contraindications, status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active','seed') ON CONFLICT (gym_id, name) DO NOTHING`,
    [gymId, e.name, e.primary, e.secondary, e.equipment, e.movement, e.level, e.execution, e.breathing, e.errors, e.variations, e.alternatives, e.contraindications]);
  inserted += r.rowCount;
}
console.log(`Ejercicios añadidos: ${inserted} (de ${EXERCISES.length}).`);
await pool.end();
