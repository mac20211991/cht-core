{
  'use strict';
  const Widget = require('enketo-core/src/js/Widget');
  const $ = require('jquery');
  const moment = require('moment');
  require('enketo-core/src/js/plugins');

  const pluginName = 'rdtoolkitprovisioningwidget';

  /**
   * @constructor
   * @param {Element} element [description]
   * @param {(boolean|{touch: boolean, repeat: boolean})} options options
   */
  function Rdtoolkitprovisioningwidget(element, options) {
    this.namespace = pluginName;
    Widget.call(this, element, options);
    this._init();
  }

  //copy the prototype functions from the Widget super class
  Rdtoolkitprovisioningwidget.prototype = Object.create(Widget.prototype);

  //ensure the constructor is the new one
  Rdtoolkitprovisioningwidget.prototype.constructor = Rdtoolkitprovisioningwidget;

  Rdtoolkitprovisioningwidget.prototype._init = function() {
    const self = this;
    const $el = $(this.element);
    const $patientId = $el.find('input[name="/rdtoolkit_provisioning/rdtoolkit_patient_id"]');

    const $translate = window.CHTCore.Translate;
    const rdToolkitService = window.CHTCore.RDToolkit;

    $el.on('click', '.btn.rdtoolkit-provision-test', function() {
      rdToolkitService
        .provisionRDTest($patientId.val())
        .then((response = {}) => {
          const sessionId = response.sessionId || '';
          const timeStarted = getDate(response.timeStarted);
          const timeResolved = getDate(response.timeResolved);
          const state = response.state || '';

          $(self.element)
            .find('input[name="/rdtoolkit_provisioning/rdtoolkit_session_id"]')
            .val(sessionId)
            .trigger('change');
          $(self.element)
            .find('input[name="/rdtoolkit_provisioning/rdtoolkit_state"]')
            .val(state)
            .trigger('change');
          $(self.element)
            .find('input[name="/rdtoolkit_provisioning/rdtoolkit_time_started"]')
            .val(timeStarted)
            .trigger('change');
          $(self.element)
            .find('input[name="/rdtoolkit_provisioning/rdtoolkit_time_resolved"]')
            .val(timeResolved)
            .trigger('change');

          $(self.element)
            .find('.rdtoolkit-actions')
            .hide();

          $(self.element)
            .find('.rdtoolkit-preview')
            .append(`
              <div>
                <span class="rdt-label">Provision test information:</span>
              </div>
              <br>
              <div>
                  <span class="rdt-label">Status: </span>
                  <span class="rdt-value">${state}</span>
              </div>
              <div>
                <span class="rdt-label">Started on: </span>
                <span class="rdt-value">${timeStarted}</span>
              </div>
              <div>
                <span class="rdt-label">Results available on: </span>
                <span class="rdt-value">${timeResolved}</span>
              </div>
              <br>
              <div>
                <span class="rdt-label">Click submit to save the information.</span>
              </div>
            `);
        });
    });

    $translate
      .get('rdtoolkit.provision')
      .toPromise()
      .then(label => {
        $el
          .find('.or-appearance-rdtoolkit_patient_id')
          .after('<div class="rdtoolkit-preview"></div>')
          .after(`
            <div class="rdtoolkit-actions">
              <a class="btn btn-primary rdtoolkit-provision-test">${label}</a>
            </div>
          `);
      });
  };

  function getDate(dateTime) {
    return dateTime && moment(dateTime).isValid() ? moment(dateTime).format('LLL'): '';
  }

  Rdtoolkitprovisioningwidget.prototype.destroy = function(element) {};  // eslint-disable-line no-unused-vars

  $.fn[ pluginName ] = function(options, event) {
    return this.each(function () {
      const $this = $( this );
      let data = $this.data(pluginName);

      options = options || {};

      if (!data && typeof options === 'object') {
        $this.data(pluginName, (data = new Rdtoolkitprovisioningwidget(this, options, event)));

      } else if (data && typeof options === 'string') {
        data[options](this);
      }
    });
  };

  module.exports = {
    'name': pluginName,
    'selector': '.or-appearance-rdtoolkit_provision',
  };
}
