// ================== CONFIG ==================
const API_URL = "https://script.google.com/macros/s/AKfycbwDkRO7vou0cYwe4P_I9dTJrXTrelJA54Kn6E5nnoqSuX5VID9UIzg-AaHB1_h_OapGkg/exec"; // <-- cambialo por tu URL

// ================== HEADER: TÍTULO ==================
const header = document.querySelector("header");

const seccionTitulo = document.createElement("section");
seccionTitulo.classList = "titulo";
header.appendChild(seccionTitulo);

const h1 = document.createElement("h1");
h1.innerText = "Bitácora de situaciones";
seccionTitulo.appendChild(h1);

// ================== MAIN ==================
const main = document.querySelector("main");

// ------- Sección para agregar situación -------
const seccionAgregar = document.createElement("section");
seccionAgregar.classList = "agregarSituacion";
main.appendChild(seccionAgregar);

// SOLO TEXTO, SIN FECHA MANUAL
const labelTexto = document.createElement("label");
labelTexto.innerText = "Situación que pasó:";
labelTexto.htmlFor = "texto-situacion";
seccionAgregar.appendChild(labelTexto);

const textarea = document.createElement("textarea");
textarea.id = "texto-situacion";
textarea.placeholder =
  "Ej: Estaba en tal lugar, pasó esto, yo pensé tal cosa, reaccioné así...";
seccionAgregar.appendChild(textarea);

// Botón: guardar situación
const buttonGuardar = document.createElement("button");
buttonGuardar.innerText = "Guardar situación";
seccionAgregar.appendChild(buttonGuardar);

// ------- Muro de situaciones -------
const seccionMuro = document.createElement("section");
seccionMuro.classList = "muro-situaciones";
main.appendChild(seccionMuro);

// ================== FUNCIONES ==================

/** Convierte una fecha en "Jueves 11 de diciembre" (en es-AR) */
function formatearFechaLarga(fecha) {
  if (!fecha) return "";
  const opciones = {
    weekday: "long",
    day: "numeric",
    month: "long",
  };
  let txt = fecha.toLocaleDateString("es-AR", opciones);
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

/** Devuelve Madrugada / Mañana / Tarde / Noche según la hora */
function obtenerFranjaHoraria(fecha) {
  if (!fecha) return "";
  const h = fecha.getHours();

  if (h >= 0 && h < 6) return "Madrugada";
  if (h >= 6 && h < 12) return "Mañana";
  if (h >= 12 && h < 18) return "Tarde";
  return "Noche";
}

/** Renderiza toda la lista en el muro */
function renderMuro(situaciones) {
  seccionMuro.innerHTML = "";

  situaciones.forEach((item) => {
    const card = document.createElement("article");
    card.classList.add("situacion-card");

    const fecha = item.timestamp ? new Date(item.timestamp) : null;

    const titulo = document.createElement("h3");
    titulo.innerText = formatearFechaLarga(fecha) || "Sin fecha";
    card.appendChild(titulo);

    // Momento del día (madrugada, mañana, tarde, noche)
    if (fecha) {
      const franja = document.createElement("p");
      franja.classList.add("situacion-franja");
      franja.innerText = "Momento del día: " + obtenerFranjaHoraria(fecha);
      card.appendChild(franja);
    }

    // Fecha/hora exacta de carga en chiquito
    if (item.timestamp) {
      const fechaCarga = new Date(item.timestamp);
      const pMeta = document.createElement("p");
      pMeta.classList.add("situacion-fecha");
      pMeta.innerText =
        "Registrado: " +
        fechaCarga.toLocaleString("es-AR", {
          dateStyle: "short",
          timeStyle: "short",
        });
      card.appendChild(pMeta);
    }

    const pTexto = document.createElement("p");
    pTexto.classList.add("situacion-texto");
    pTexto.innerText = item.texto || "";
    card.appendChild(pTexto);

    seccionMuro.appendChild(card);
  });
}

/** Carga todas las situaciones desde Apps Script */
async function cargarSituaciones() {
  try {
    const resp = await fetch(API_URL); // modo "list"
    const situaciones = await resp.json();

    // ordenar por timestamp descendente (más reciente arriba)
    situaciones.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });

    renderMuro(situaciones);
  } catch (err) {
    console.error("Error al cargar situaciones", err);
  }
}

/** Agrega una nueva situación (GET ?modo=add) */
async function agregarSituacionAPI(texto) {
  const textoLimpio = (texto || "").trim();
  if (!textoLimpio) return;

  const url =
    API_URL +
    "?modo=add" +
    "&texto=" +
    encodeURIComponent(textoLimpio);

  try {
    await fetch(url);
    await cargarSituaciones();
  } catch (err) {
    console.error("Error al guardar situación", err);
  }
}

// ================== EVENTOS ==================

buttonGuardar.addEventListener("click", () => {
  agregarSituacionAPI(textarea.value);
  textarea.value = "";
  textarea.focus();
});

// Ctrl+Enter en el textarea también guarda
textarea.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.ctrlKey) {
    event.preventDefault();
    buttonGuardar.click();
  }
});

// Cargar al iniciar
window.addEventListener("load", cargarSituaciones);
