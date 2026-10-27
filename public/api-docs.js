'use strict';

/* global SwaggerUIBundle */
window.addEventListener('load', () => {
  window.ui = SwaggerUIBundle({ url: '/swagger.json', dom_id: '#swagger-ui' });
});
