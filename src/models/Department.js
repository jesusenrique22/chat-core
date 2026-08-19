/**
 * ============================================
 * Modelo: Department (Departamento CPU)
 * ============================================
 * Representa las unidades o departamentos del Centro de Procesamiento Urbano (CPU)
 * a los cuales los contribuyentes pueden dirigir citas o trámites.
 * Ejemplos: Catastro, Control Urbano, Permisología Urbano-Ambiental, etc.
 */

const mongoose = require('mongoose');

const departmentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'El nombre del departamento es obligatorio'],
    trim: true,
    unique: true
  },
  code: {
    type: String,
    required: [true, 'El código abreviado del departamento es obligatorio'],
    unique: true,
    uppercase: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  headName: {
    type: String,
    default: 'Jefe de Departamento'
  },
  headEmail: {
    type: String,
    default: ''
  },
  capacityPerHour: {
    type: Number,
    default: 5
  },
  workHours: {
    start: { type: String, default: '08:00' },
    end: { type: String, default: '16:00' }
  },
  active: {
    type: Boolean,
    default: true,
    index: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Department', departmentSchema);
