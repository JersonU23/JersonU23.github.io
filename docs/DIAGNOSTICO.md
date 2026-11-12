# Diagnóstico inicial del proyecto (12-nov-2026)

## 1. Arquitectura actual (antes de esta intervención)
El repositorio `JersonU23.github.io` era un sitio de **GitHub Pages** sin código de aplicación. Su historial contiene solo:

| Commit | Contenido |
|---|---|
| `221f686` | `Diapositiva_Defensa_Visual.html`: presentación académica estática ("Desajuste educativo e informalidad juvenil") |
| `b152020` | `index.html` que redirigía a esa presentación |
| `5d1d388`, `49dc034` | Eliminación de ambos archivos por el propietario |

En la rama de trabajo, el árbol estaba **vacío**.

## 2. Tecnologías utilizadas
Solo HTML/CSS estático servido por GitHub Pages. No había backend, base de datos, autenticación, APIs ni proveedor de IA.

## 3. Funcionalidades terminadas
Ninguna relacionada con FITNESS AI.

## 4. Funcionalidades incompletas
Todas las del alcance (gestión de gimnasio, usuarios, evaluación, IA, nutrición, seguimiento, conocimiento, reportes).

## 5. Problemas detectados
- No existía código que conservar. El contenido previo no tiene relación con el producto y ya lo había eliminado el propietario, así que no se borró ningún dato.
- **GitHub Pages solo sirve archivos estáticos.** No puede ejecutar el backend, la base de datos ni guardar de forma segura la clave de IA, así que una plataforma SaaS real no puede funcionar solo con Pages.

## 6. Riesgos técnicos
| Riesgo | Mitigación aplicada |
|---|---|
| Datos de salud sensibles | Cifrado AES-256-GCM de la sección de salud, control de acceso por asignación y minimización de lo que se envía a la IA |
| Costos de IA descontrolados | IA solo en 4 operaciones, cuotas, presupuesto mensual con bloqueo, reutilización de respuestas idénticas y registro de tokens y costo por solicitud |
| Recomendaciones inseguras | Datos críticos obligatorios, cribado previo a la actividad física, autorización médica, derivación nutricional y aprobación obligatoria del entrenador |
| Referencias inventadas por la IA | La IA solo puede citar registros validados que se le entregan; las citas desconocidas se descartan y lo demás se etiqueta como "inferencia" |
| Pérdida de la clave de cifrado | Documentado: guardarla en un gestor de secretos y respaldarla aparte de la base de datos |
| Escalar a más gimnasios | Esquema multi-gimnasio desde el inicio (`gym_id` en todas las entidades) |

## 7. Mejoras prioritarias (decididas)
1. Construir el backend con API segura, base de datos persistente y autenticación por roles.
2. Hacer el frontend PWA responsive servido por el mismo backend.
3. Desplegar en un servicio con Node.js y PostgreSQL gestionado. GitHub Pages queda solo para una landing estática opcional.

## 8. Plan de implementación
Se siguió el orden pedido. El estado de cada etapa está en el [README](../README.md#estado-por-etapas).
